#!/usr/bin/env python3
"""Otter Chess WebSocket server for Chesshook external engine."""

import asyncio
import os
import sys

try:
    import chess
    import websockets
    from otter import OtterModel
except ImportError:
    print("Install dependencies: pip install otter-chess websockets")
    sys.exit(1)

WS_HOST = "127.0.0.1"
WS_PORT = 8080


class OtterEngine:
    def __init__(self):
        print("Loading Otter model (first run downloads weights)...")
        self.model = OtterModel(device="cpu")
        self.move_history = []
        self.time_control = "600+0"
        self.clock_fraction = 1.0
        print("Otter model loaded.")

    def reset(self):
        self.move_history = []
        self.clock_fraction = 1.0

    def set_time_control(self, tc):
        self.time_control = tc

    def set_clock_fraction(self, fraction):
        self.clock_fraction = max(0.0, min(1.0, fraction))

    def add_move(self, uci_move):
        self.move_history.append(uci_move)
        if len(self.move_history) > 20:
            self.move_history = self.move_history[-20:]

    def predict(self, board, player_elo, opponent_elo):
        fen = board.fen()
        history = list(self.move_history)

        res = self.model.predict(
            fen=fen,
            player_elo=player_elo,
            opponent_elo=opponent_elo,
            history_moves=history,
            time_control=self.time_control,
            clock_fraction=self.clock_fraction,
            top_k=1,
        )

        if res["moves"]:
            return res["moves"][0]["move"]
        return None


class ConnectionHandler:
    def __init__(self, engine):
        self.engine = engine
        self.board = chess.Board()
        self.has_lock = False
        self.pass_key = "passkey"
        self.player_elo = 1500
        self.opponent_elo = 1500
        self.time_control = "600+0"

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
            await ws.send("engine otter")

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
            self.engine.reset()
            await ws.send("unlockok")

        elif msg.startswith("setelo "):
            parts = msg.split()
            if len(parts) == 3:
                self.player_elo = int(parts[1])
                self.opponent_elo = int(parts[2])
                print(f"  Elo set: self={self.player_elo} oppo={self.opponent_elo}")

        elif msg.startswith("position fen "):
            try:
                new_board = chess.Board(msg[13:])
                if self.board.is_valid() and new_board.is_valid():
                    diff = self.board.fen().split()[0] != new_board.fen().split()[0]
                    if diff:
                        for move in self.board.legal_moves:
                            test_board = self.board.copy()
                            test_board.push(move)
                            if test_board.fen().split()[0] == new_board.fen().split()[0]:
                                self.engine.add_move(move.uci())
                                break
                self.board = new_board
            except ValueError as e:
                print(f"  Bad FEN: {e}")

        elif msg.startswith("go"):
            if not self.has_lock:
                await ws.send("error no lock")
                return

            parts = msg.split()
            white_time = None
            black_time = None
            winc = 0
            binc = 0

            for i, p in enumerate(parts):
                if p == "wtime" and i + 1 < len(parts):
                    white_time = int(parts[i + 1])
                elif p == "btime" and i + 1 < len(parts):
                    black_time = int(parts[i + 1])
                elif p == "winc" and i + 1 < len(parts):
                    winc = int(parts[i + 1])
                elif p == "binc" and i + 1 < len(parts):
                    binc = int(parts[i + 1])

            if white_time is not None and black_time is not None:
                is_white = self.board.turn == chess.WHITE
                my_time = white_time if is_white else black_time
                total_time = white_time + black_time + (winc + binc) * 40
                if total_time > 0:
                    self.engine.set_clock_fraction(my_time / total_time)

                base = min(white_time, black_time)
                inc = winc if is_white else binc
                eff = base // 1000 + 40 * inc // 1000
                if eff < 60:
                    self.time_control = "30+0"
                elif eff < 180:
                    self.time_control = "180+0"
                elif eff < 600:
                    self.time_control = "600+0"
                elif eff < 1800:
                    self.time_control = "1800+0"
                else:
                    self.time_control = "3600+0"
                self.engine.set_time_control(self.time_control)

            best = self.engine.predict(self.board, self.player_elo, self.opponent_elo)
            if best:
                try:
                    self.board.parse_uci(best)
                    self.engine.add_move(best)
                    print(f"  -> bestmove {best}")
                    await ws.send(f"bestmove {best}")
                except Exception:
                    await ws.send("bestmove 0000")
            else:
                await ws.send("bestmove 0000")

        else:
            print(f"  Unknown: {msg}")


def main():
    engine = OtterEngine()
    print(f"WebSocket server: ws://{WS_HOST}:{WS_PORT}")
    print("Chesshook external engine URL: ws://localhost:8080/ws")

    async def handle_connection(ws):
        handler = ConnectionHandler(engine)
        await handler.handle(ws)

    async def run():
        async with websockets.serve(handle_connection, WS_HOST, WS_PORT):
            await asyncio.Future()

    asyncio.run(run())


if __name__ == "__main__":
    main()
