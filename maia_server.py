#!/usr/bin/env python3
"""Maia-3 ONNX WebSocket server for Chesshook external engine."""

import asyncio
import os
import sys

try:
    import chess
    import onnxruntime as ort
    import numpy as np
    import websockets
except ImportError:
    print("Install dependencies: pip install chess onnxruntime numpy websockets")
    sys.exit(1)

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "maia3-23m.fp16.onnx")
WS_HOST = "127.0.0.1"
WS_PORT = 8080

PIECE_TO_IDX = {
    chess.PAWN: 0, chess.KNIGHT: 1, chess.BISHOP: 2,
    chess.ROOK: 3, chess.QUEEN: 4, chess.KING: 5,
}

def _mirror_sq(sq):
    return sq ^ 56

def board_to_tokens(board):
    tokens = np.zeros((64, 12), dtype=np.float32)
    for sq in range(64):
        piece = board.piece_at(sq)
        if piece is not None:
            idx = PIECE_TO_IDX[piece.piece_type]
            if piece.color == chess.BLACK:
                idx += 6
            tokens[sq][idx] = 1.0
    return tokens

def encode_board_for_maia(board):
    tokens = board_to_tokens(board)
    is_black = board.turn == chess.BLACK
    if is_black:
        tokens = tokens.reshape(8, 8, 12)[::-1, :, :].reshape(64, 12)
    return tokens, is_black

def move_to_vocab_idx(board, move, is_black):
    f = _mirror_sq(move.from_square) if is_black else move.from_square
    t = _mirror_sq(move.to_square) if is_black else move.to_square
    if move.promotion is not None:
        promo_map = {chess.QUEEN: 0, chess.ROOK: 1, chess.BISHOP: 2, chess.KNIGHT: 3}
        return 4096 + (f * 64 + t) * 4 + promo_map[move.promotion]
    return f * 64 + t

def get_legal_mask(board, is_black):
    mask = np.zeros(4352, dtype=np.float32)
    for move in board.legal_moves:
        mask[move_to_vocab_idx(board, move, is_black)] = 1.0
    return mask

def idx_to_move(idx):
    if idx < 4096:
        return idx // 64, idx % 64, None
    promo_idx = idx - 4096
    p = promo_idx % 4
    base = promo_idx // 4
    promo_pieces = [chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT]
    return base // 64, base % 64, promo_pieces[p]

class MaiaEngine:
    def __init__(self, model_path):
        print(f"Loading Maia model from {model_path}...")
        self.session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
        self.elo_self = 1500
        self.elo_oppo = 1500
        print("Maia model loaded.")

    def set_elo(self, elo_self, elo_oppo=None):
        self.elo_self = elo_self
        self.elo_oppo = elo_oppo or elo_self

    def predict(self, board):
        tokens, is_black = encode_board_for_maia(board)
        mask = get_legal_mask(board, is_black)

        outputs = self.session.run(None, {
            "tokens": tokens.reshape(1, 64, 12),
            "elo_self": np.array([self.elo_self], dtype=np.float32),
            "elo_oppo": np.array([self.elo_oppo], dtype=np.float32),
        })

        logits = outputs[0][0]
        logits[mask == 0] = -1e9
        best_idx = int(np.argmax(logits))

        from_sq, to_sq, promo = idx_to_move(best_idx)
        if is_black:
            from_sq = _mirror_sq(from_sq)
            to_sq = _mirror_sq(to_sq)

        move = chess.Move(from_sq, to_sq, promotion=promo)
        if move in board.legal_moves:
            return move.uci()

        # Fallback: best legal move by logit score
        best_score = -1e18
        best_move = None
        for m in board.legal_moves:
            idx = move_to_vocab_idx(board, m, is_black)
            if logits[idx] > best_score:
                best_score = logits[idx]
                best_move = m.uci()
        return best_move

class ConnectionHandler:
    def __init__(self, engine):
        self.engine = engine
        self.board = chess.Board()
        self.has_lock = False
        self.pass_key = "passkey"

    async def handle(self, ws):
        print(f"Client connected: {ws.remote_address}")
        try:
            async for msg in ws:
                await self.process(ws, msg.strip())
        except websockets.exceptions.ConnectionClosed:
            pass
        print("Client disconnected.")

    async def process(self, ws, msg):
        print(f"  <- {msg}")

        if msg == "whoareyou":
            await ws.send("iam v1")

        elif msg == "whatengine":
            await ws.send("engine maia-3")

        elif msg.startswith("auth "):
            await ws.send("authok" if msg[5:] == self.pass_key else "authfail")

        elif msg == "sub":
            await ws.send("subok")

        elif msg == "unsub":
            await ws.send("unsubok")

        elif msg == "lock":
            self.has_lock = True
            await ws.send("lockok")

        elif msg == "unlock":
            self.has_lock = False
            await ws.send("unlockok")

        elif msg.startswith("position fen "):
            try:
                self.board = chess.Board(msg[13:])
            except ValueError as e:
                print(f"  Bad FEN: {e}")

        elif msg.startswith("setelo "):
            parts = msg.split()
            if len(parts) == 3:
                self.engine.set_elo(int(parts[1]), int(parts[2]))
                print(f"  Elo set: self={parts[1]} oppo={parts[2]}")

        elif msg.startswith("go"):
            if not self.has_lock:
                await ws.send("error no lock")
                return

            best = self.engine.predict(self.board)
            print(f"  -> bestmove {best}")
            await ws.send(f"bestmove {best}")

        else:
            print(f"  Unknown: {msg}")

def main():
    if not os.path.exists(MODEL_PATH):
        print(f"Model not found: {MODEL_PATH}")
        sys.exit(1)

    engine = MaiaEngine(MODEL_PATH)
    handler = ConnectionHandler(engine)

    async def handle_connection(ws):
        handler = ConnectionHandler(engine)
        await handler.handle(ws)

    print(f"WebSocket server: ws://{WS_HOST}:{WS_PORT}")
    print("Chesshook external engine URL: ws://localhost:8080/ws")

    async def run():
        async with websockets.serve(handle_connection, WS_HOST, WS_PORT):
            await asyncio.Future()

    asyncio.run(run())

if __name__ == "__main__":
    main()
