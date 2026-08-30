// Maia-3 Chess Engine — ONNX browser inference via onnxruntime-web
// Same public API as betafishEngine. Requires chess.js and onnxruntime-web via @require.

const maiaEngine = function() {

  var MODEL_URL = 'https://raw.githubusercontent.com/heyncth/fictional-funicular/main/models/maia3-23m.fp16.onnx';
  var WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.2/dist/';

  // Set WASM paths before any ORT init — use object form so ORT loads mjs from CDN
  if (typeof ort !== 'undefined' && ort.env && ort.env.wasm) {
    ort.env.wasm.wasmPaths = {
      mjs: WASM_BASE + 'ort-wasm-simd-threaded.jsep.mjs',
      wasm: WASM_BASE + 'ort-wasm-simd-threaded.jsep.wasm',
    };
    ort.env.wasm.numThreads = 1;
  }
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Piece index for Maia-3 token encoding
  var _pieceToIdx = { P:0, N:1, B:2, R:3, Q:4, K:5, p:6, n:7, b:8, r:9, q:10, k:11 };

  var _promoPieces = ['q', 'r', 'b', 'n'];

  var _session = null;
  var _modelLoading = false;
  var _board = new Chess();
  var _eloSelf = 1500;
  var _eloOppo = 1500;
  var _pendingInference = null; // Promise for pre-cached result
  var _cachedBestMove = null;

  // ----- Move Vocabulary (4352 entries) -----

  function _indexToSq(idx) {
    var rank = Math.floor(idx / 8);
    var file = idx % 8;
    return String.fromCharCode(97 + file) + (rank + 1);
  }

  function _buildMoveVocab() {
    var vocab = new Array(4352);
    var idx = 0;
    var from, to, i;

    // Basic moves: from_sq*64 + to_sq (indices 0-4095)
    for (from = 0; from < 64; from++) {
      for (to = 0; to < 64; to++) {
        vocab[idx++] = _indexToSq(from) + _indexToSq(to);
      }
    }

    // Promotion moves (indices 4096-4351):
    // White pawns on rank 7 (sq 48-55) -> rank 1 (sq 56-63)
    for (from = 48; from <= 55; from++) {
      for (to = 56; to <= 63; to++) {
        for (i = 0; i < 4; i++) {
          vocab[idx++] = _indexToSq(from) + _indexToSq(to) + _promoPieces[i];
        }
      }
    }
    // Black pawns on rank 2 (sq 8-15) -> rank 1 (sq 0-7)
    for (from = 8; from <= 15; from++) {
      for (to = 0; to <= 7; to++) {
        for (i = 0; i < 4; i++) {
          vocab[idx++] = _indexToSq(from) + _indexToSq(to) + _promoPieces[i];
        }
      }
    }

    return vocab;
  }

  var _moveVocab = _buildMoveVocab();

  function _buildMoveIndex() {
    var map = {};
    for (var i = 0; i < _moveVocab.length; i++) {
      map[_moveVocab[i]] = i;
    }
    return map;
  }

  var _moveIndex = _buildMoveIndex();

  // ----- Board Encoding -----

  function _boardToTokens(fen) {
    var tensor = new Float32Array(64 * 12);
    var piecePlacement = fen.split(' ')[0];
    var rows = piecePlacement.split('/');

    for (var rank = 0; rank < 8; rank++) {
      var row = 7 - rank; // FEN rank 8 = row 0
      var file = 0;
      var rowStr = rows[rank];
      for (var ci = 0; ci < rowStr.length; ci++) {
        var ch = rowStr[ci];
        if (ch >= '1' && ch <= '8') {
          file += parseInt(ch);
        } else {
          var pieceIdx = _pieceToIdx[ch];
          var square = row * 8 + file;
          tensor[square * 12 + pieceIdx] = 1.0;
          file++;
        }
      }
    }

    return tensor;
  }

  function _mirrorSquare(sq) {
    return sq[0] + String.fromCharCode(105 - sq.charCodeAt(1));
  }

  function _mirrorMove(uci) {
    var promo = uci.length > 4 ? uci.substring(4) : '';
    return _mirrorSquare(uci.substring(0, 2)) + _mirrorSquare(uci.substring(2, 4)) + promo;
  }

  // Mirror a FEN string vertically (chess.js 0.10.3 compat)
  function _mirrorFen(fen) {
    var parts = fen.split(' ');
    var rows = parts[0].split('/');
    var mirrored = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var row = '';
      for (var j = 0; j < rows[i].length; j++) {
        var ch = rows[i][j];
        if (ch === ch.toUpperCase()) {
          row += ch.toLowerCase();
        } else {
          row += ch.toUpperCase();
        }
      }
      mirrored.push(row);
    }
    // Flip side to move
    var side = parts[1] === 'w' ? 'b' : 'w';
    // Flip castling (swap K<->q, Q<->k)
    var castle = parts[2];
    if (castle !== '-') {
      var newCastle = '';
      for (var k = 0; k < castle.length; k++) {
        var c = castle[k];
        if (c === 'K') newCastle += 'q';
        else if (c === 'Q') newCastle += 'k';
        else if (c === 'k') newCastle += 'Q';
        else if (c === 'q') newCastle += 'K';
      }
      // Remove duplicates and sort
      var unique = '';
      if (newCastle.indexOf('K') !== -1) unique += 'K';
      if (newCastle.indexOf('Q') !== -1) unique += 'Q';
      if (newCastle.indexOf('k') !== -1) unique += 'k';
      if (newCastle.indexOf('q') !== -1) unique += 'q';
      castle = unique || '-';
    }
    // Flip en passant
    var ep = parts[3];
    if (ep !== '-') {
      ep = ep[0] + (9 - parseInt(ep[1]));
    }
    return mirrored.join('/') + ' ' + side + ' ' + castle + ' ' + ep + ' ' + parts[4] + ' ' + parts[5];
  }

  // ----- ONNX Session -----

  function _loadModel() {
    if (_session || _modelLoading) return;
    _modelLoading = true;

    // Fetch WASM binary via GM_xmlhttpRequest (bypasses CSP), then pass directly to ORT
    var wasmUrl = WASM_BASE + 'ort-wasm-simd-threaded.jsep.wasm';
    if (typeof GM_xmlhttpRequest !== 'undefined') {
      GM_xmlhttpRequest({
        method: 'GET',
        url: wasmUrl,
        responseType: 'arraybuffer',
        onload: function(res) {
          if (res.status === 200 || res.status === 0) {
            ort.env.wasm.wasmBinary = res.response;
            _doCreateSession();
          } else {
            console.error('[Maia] Failed to fetch WASM binary:', res.status);
            _modelLoading = false;
          }
        },
        onerror: function(err) {
          console.error('[Maia] GM_xmlhttpRequest error for WASM:', err);
          _modelLoading = false;
        }
      });
    } else {
      // Fallback: try direct fetch (may fail due to CSP)
      _doCreateSession();
    }
  }

  function _doCreateSession() {
    ort.InferenceSession.create(MODEL_URL, {
      graphOptimizationLevel: 'basic',
      executionProviders: ['wasm'],
    }).then(function(session) {
      _session = session;
      _modelLoading = false;
      console.log('[Maia] Model loaded');
    }).catch(function(err) {
      _modelLoading = false;
      console.error('[Maia] Failed to load model:', err);
    });
  }

  // ----- Inference -----

  function _runInference(board) {
    if (!_session) return Promise.resolve(null);

    var isBlack = board.turn() === 'b';

    // Mirror board so model always sees from white's perspective
    var evalFen = isBlack ? _mirrorFen(board.fen()) : board.fen();
    var tokens = _boardToTokens(evalFen);

    var feeds = {
      tokens: new ort.Tensor('float32', tokens, [1, 64, 12]),
      elo_self: new ort.Tensor('float32', new Float32Array([_eloSelf]), [1]),
      elo_oppo: new ort.Tensor('float32', new Float32Array([_eloOppo]), [1]),
    };

    return _session.run(feeds).then(function(results) {
      var logitsMove = results.logits_move.data;

      // Get legal moves from the original board
      var legalMoves = board.moves({ verbose: true });

      var legalIndices = [];
      var legalUcis = [];
      for (var i = 0; i < legalMoves.length; i++) {
        var uci = legalMoves[i].uci;
        var vocabUci = isBlack ? _mirrorMove(uci) : uci;
        var idx = _moveIndex[vocabUci];
        if (idx !== undefined) {
          legalIndices.push(idx);
          legalUcis.push(uci);
        }
      }

      if (legalIndices.length === 0) return null;

      // Mask illegal moves and find argmax
      var bestIdx = -1;
      var bestLogit = -Infinity;
      for (var j = 0; j < legalIndices.length; j++) {
        var logit = logitsMove[legalIndices[j]];
        if (logit > bestLogit) {
          bestLogit = logit;
          bestIdx = j;
        }
      }

      return legalUcis[bestIdx];
    });
  }

  // ----- Public API -----

  function getFEN() {
    return _board.fen();
  }

  function setFEN(fen) {
    _board.load(fen);
    _cachedBestMove = null;
    // Pre-cache: run async inference so getBestMove returns sync
    if (_session) {
      _pendingInference = _runInference(_board).then(function(move) {
        _cachedBestMove = move;
        _pendingInference = null;
        return move;
      });
    } else {
      _loadModel();
    }
  }

  function getMovesAtSquare(square) {
    var moves = _board.moves({ square: square, verbose: true });
    return moves.map(function(m) { return m.to; });
  }

  function move(from, to) {
    var moveObj = _board.move({ from: from, to: to, promotion: 'q' });
    if (moveObj === null) {
      moveObj = _board.move({ from: from, to: to });
    }
    return moveObj !== null;
  }

  function getBestMove() {
    // Return cached result from setFEN pre-cache
    if (_cachedBestMove !== null) {
      var m = _cachedBestMove;
      _cachedBestMove = null;
      return m;
    }
    // Fallback: run inference now (will be null if model not loaded)
    if (!_session) return null;
    // This path returns undefined (async) — callers should use setFEN first
    return null;
  }

  function makeAIMove() {
    if (gameStatus().over) return false;
    var bestMove = getBestMove();
    if (!bestMove) return false;
    _board.move(bestMove);
    return true;
  }

  function reset() {
    _board.reset();
    _cachedBestMove = null;
    _pendingInference = null;
  }

  function gameStatus() {
    var sideToMove = _board.turn() === 'w' ? 'white' : 'black';
    var over = false;

    if (_board.in_checkmate()) over = 'Checkmate!';
    else if (_board.in_stalemate()) over = 'Game drawn by stalemate';
    else if (_board.in_draw()) over = 'Game is a draw';
    else if (_board.in_threefold_repetition()) over = 'Game drawn by threefold repetition';
    else if (_board.insufficient_material()) over = 'Game drawn by insufficient material';

    return { over: over, sideToMove: sideToMove, check: _board.in_check() };
  }

  function setThinkingTime(time) {
    // Repurpose for Elo selection (1500-2800 range)
    _eloSelf = Math.round(1500 + (time - 1) * (2800 - 1500) / 29);
    if (_eloSelf < 1500) _eloSelf = 1500;
    if (_eloSelf > 2800) _eloSelf = 2800;
    _eloOppo = _eloSelf;
  }

  // Load model on init
  _loadModel();

  return {
    getFEN: getFEN,
    setFEN: setFEN,
    getMovesAtSquare: getMovesAtSquare,
    move: move,
    makeAIMove: makeAIMove,
    getBestMove: getBestMove,
    reset: reset,
    gameStatus: gameStatus,
    setThinkingTime: setThinkingTime,
  };
};
