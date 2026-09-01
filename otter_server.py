#!/usr/bin/env python3
"""Otter Chess WebSocket server for Chesshook external engine."""

import asyncio
import os
import sys

try:
    import chess
    import chess.engine
    import websockets
    from otter_chess import OtterModel
except ImportError:
    print("Install dependencies: pip install otter-chess websockets")
    sys.exit(1)

WS_HOST = "127.0.0.1"
WS_PORT = 8080
MAX_PLAYER_ELO = 3000
STOCKFISH_PATH = os.environ.get("STOCKFISH_PATH", "stockfish-windows-x86-64.exe")
STOCKFISH_DEPTH = 12

# Adaptive thresholds based on position type
# (drop_threshold, eval_floor) in centipawns
FILTER_WINNING = (150, None)    # eval > +1.5: protect lead, no floor
FILTER_EQUAL   = (100, -200)    # eval -1.5 to +1.5: stay solid
FILTER_LOSING  = (50,  -300)    # eval < -1.5: find drawing chances

# Blended move selection: balances human character with objective strength
# 0.0 = pure human (highest Otter prob), 1.0 = pure Stockfish (highest eval)
BLEND_HUMAN = 0.70   # 70% human character
BLEND_EVAL  = 0.30   # 30% objective strength


class OtterEngine:
    def __init__(self):
        print("Loading Otter model (first run downloads weights)...")
        self.model = OtterModel(device="cpu")
        self.move_history = []
        self.time_control = "600+0"
        self.white_clock = 1.0
        self.black_clock = 1.0
        print("Otter model loaded.")

        self.sf = None
        try:
            self.sf = chess.engine.SimpleEngine.popen_uci(STOCKFISH_PATH)
            print(f"Stockfish loaded: {STOCKFISH_PATH}")
        except Exception as e:
            print(f"Stockfish not available ({e}) — running Otter only (no safety filter)")

    def reset(self):
        self.move_history = []
        self.white_clock = 1.0
        self.black_clock = 1.0

    def set_time_control(self, tc):
        self.time_control = tc

    def set_clock_fraction(self, white_frac, black_frac):
        self.white_clock = max(0.0, min(1.0, white_frac))
        self.black_clock = max(0.0, min(1.0, black_frac))

    def add_move(self, uci_move):
        self.move_history.append(uci_move)
        if len(self.move_history) > 20:
            self.move_history = self.move_history[-20:]

    def predict(self, board, player_elo, opponent_elo):
        """Return list of {move, probability} dicts from Otter (top 5)."""
        fen = board.fen()
        history = list(self.move_history)
        clock = self.white_clock if board.turn == chess.WHITE else self.black_clock

        res = self.model.predict(
            fen=fen,
            player_elo=player_elo,
            opponent_elo=opponent_elo,
            history_moves=history,
            time_control=self.time_control,
            clock_fraction=clock,
            top_k=5,
        )

        moves = res.get("moves", [])
        if moves:
            print(f"  Otter top-5: " + " | ".join(
                f"{m['move']} ({m.get('probability',0)*100:.1f}%)" for m in moves
            ))
        return moves

    def stockfish_eval(self, board, uci_move):
        """Evaluate a single move with Stockfish. Returns score in centipawns from side-to-move perspective."""
        if not self.sf:
            return None
        try:
            board_copy = board.copy()
            move = chess.Move.from_uci(uci_move)
            if move not in board_copy.legal_moves:
                return None
            board_copy.push(move)
            info = self.sf.analyse(board_copy, chess.engine.Limit(depth=STOCKFISH_DEPTH))
            score = info["score"].white().score(mate_score=10000)
            # Return from the original side-to-move's perspective
            if board.turn == chess.BLACK:
                score = -score
            return score
        except Exception as e:
            print(f"  Stockfish eval error for {uci_move}: {e}")
            return None

    def get_position_type(self, eval_score):
        """Classify position as winning, equal, or losing from side-to-move perspective."""
        if eval_score > 150:     # > +1.5 pawns
            return "WINNING"
        elif eval_score < -150:  # < -1.5 pawns
            return "LOSING"
        else:
            return "EQUAL"

    def get_thresholds(self, eval_score):
        """Return (drop_threshold, eval_floor) based on position type."""
        pos_type = self.get_position_type(eval_score)
        if pos_type == "WINNING":
            return FILTER_WINNING
        elif pos_type == "LOSING":
            return FILTER_LOSING
        else:
            return FILTER_EQUAL

    def filter_moves(self, board, otter_moves):
        """
        Adaptive filter: thresholds adjust based on position type.
        Returns (best_move, sf_best_move).
        """
        if not self.sf or not otter_moves:
            return (otter_moves[0]["move"] if otter_moves else None, None)

        # Get Stockfish's own best move and eval for fallback + position assessment
        sf_result = self.sf.analyse(board, chess.engine.Limit(depth=STOCKFISH_DEPTH))
        sf_best = sf_result["pv"][0].uci() if sf_result.get("pv") else None
        sf_best_score = sf_result["score"].white().score(mate_score=10000)
        if board.turn == chess.BLACK:
            sf_best_score = -sf_best_score

        # Get adaptive thresholds based on current position
        drop_thresh, eval_floor = self.get_thresholds(sf_best_score)
        pos_type = self.get_position_type(sf_best_score)
        floor_str = f"{eval_floor/100:.1f}" if eval_floor is not None else "none"
        print(f"  Stockfish best: {sf_best} (eval: {sf_best_score/100:+.2f}) [{pos_type} | drop≤{drop_thresh/100:.1f} floor≥{floor_str}]")

        # Evaluate each Otter move
        scored = []
        for m in otter_moves:
            uci = m["move"]
            score = self.stockfish_eval(board, uci)
            if score is not None:
                drop = sf_best_score - score
                print(f"    {uci}: eval={score/100:+.2f}  drop={drop/100:.2f}")
                scored.append((uci, score, drop, m.get("probability", 0)))
            else:
                scored.append((uci, None, None, m.get("probability", 0)))

        # Apply adaptive filters
        accepted = []  # (uci, probability, eval_score)
        for uci, score, drop, prob in scored:
            if score is None:
                accepted.append((uci, prob, 0))
                continue
            if drop > drop_thresh:
                print(f"    {uci}: REJECTED (drop {drop/100:.2f} > {drop_thresh/100:.1f})")
                continue
            if eval_floor is not None and score < eval_floor:
                print(f"    {uci}: REJECTED (eval {score/100:.2f} < floor {eval_floor/100:.1f})")
                continue
            accepted.append((uci, prob, score))

        if accepted:
            # Blended selection: balance human character with objective strength
            if len(accepted) > 1 and any(a[2] != 0 for a in accepted):
                # Normalize eval scores to [0, 1] range among accepted moves
                evals = [a[2] for a in accepted if a[2] != 0]
                if evals:
                    min_eval = min(evals)
                    max_eval = max(evals)
                    eval_range = max_eval - min_eval if max_eval != min_eval else 1

                    def blended_score(item):
                        uci, prob, ev = item
                        if ev == 0:
                            return prob * BLEND_HUMAN  # un-evaluated: pure human
                        normalized = (ev - min_eval) / eval_range  # 0=worst, 1=best
                        return prob * BLEND_HUMAN + normalized * BLEND_EVAL

                    best = max(accepted, key=blended_score)
                else:
                    best = max(accepted, key=lambda x: x[1])
            else:
                best = max(accepted, key=lambda x: x[1])
            print(f"  Filter result: {best[0]} (from {len(accepted)}/{len(otter_moves)} accepted, blend={BLEND_HUMAN:.0%}human+{BLEND_EVAL:.0%}eval)")
            return (best[0], sf_best)
        else:
            # Adaptive fallback: least-bad Otter if close to Stockfish, else Stockfish
            # Find the Otter move with highest eval (least bad)
            evaluable = [(uci, score) for uci, score, drop, prob in scored if score is not None]
            if evaluable:
                least_bad_uci, least_bad_eval = max(evaluable, key=lambda x: x[1])
                gap = sf_best_score - least_bad_eval
                gap_pawns = gap / 100
                if gap < 100:  # within 1.0 pawn of Stockfish best
                    print(f"  All rejected but {least_bad_uci} is close (gap={gap_pawns:.2f}) — playing least-bad Otter")
                    return (least_bad_uci, sf_best)
                else:
                    print(f"  All rejected, gap too large ({gap_pawns:.2f} pawns) — falling back to Stockfish: {sf_best}")
                    return (sf_best, sf_best)
            else:
                print(f"  All rejected, no evals available — falling back to Stockfish: {sf_best}")
                return (sf_best, sf_best)


class ConnectionHandler:
    def __init__(self, engine):
        self.engine = engine
        self.board = chess.Board()
        self.has_lock = False
        self.pass_key = "passkey"
        self.playing_as = 0
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
            if len(parts) >= 2:
                try:
                    self.playing_as = int(parts[1])
                except ValueError:
                    self.playing_as = 0
                print(f"  Playing as: {'W' if self.playing_as == 1 else 'B' if self.playing_as == 2 else '?'} (using max elo {MAX_PLAYER_ELO})")

        elif msg.startswith("history "):
            san_moves = msg[8:].split()
            self.engine.move_history = []
            temp_board = chess.Board()
            for san in san_moves:
                try:
                    move = temp_board.parse_san(san)
                    self.engine.move_history.append(move.uci())
                    temp_board.push(move)
                except Exception as e:
                    print(f"  Bad SAN: {san} - {e}")
            print(f"  History: {len(self.engine.move_history)} moves")

        elif msg.startswith("timecontrol "):
            self.engine.set_time_control(msg[12:])
            print(f"  Time control: {msg[12:]}")

        elif msg.startswith("clock "):
            parts = msg.split()
            try:
                wf = float(parts[1])
                bf = float(parts[2])
                self.engine.set_clock_fraction(wf, bf)
                print(f"  Clock: W={wf:.2%} B={bf:.2%}")
            except (ValueError, IndexError):
                pass

        elif msg.startswith("position fen "):
            try:
                self.board = chess.Board(msg[13:])
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

            elo = MAX_PLAYER_ELO
            print(f"  Turn: {'W' if self.board.turn == chess.WHITE else 'B'} | player_elo={elo}")

            # Get Otter's top-5 moves
            otter_moves = self.engine.predict(self.board, elo, elo)
            if not otter_moves:
                await ws.send("bestmove 0000")
                return

            # Apply Stockfish safety filter
            best, sf_fallback = self.engine.filter_moves(self.board, otter_moves)
            if best:
                try:
                    self.board.parse_uci(best)
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
    if engine.sf:
        print(f"Stockfish safety filter: ON (depth={STOCKFISH_DEPTH})")
        print(f"  Winning (> +1.5): drop≤1.5, no floor")
        print(f"  Equal (-1.5 to +1.5): drop≤1.0, floor≥-2.0")
        print(f"  Losing (< -1.5): drop≤0.5, floor≥-3.0")
        print(f"  Selection: {BLEND_HUMAN:.0%} human + {BLEND_EVAL:.0%} eval (blended)")
    else:
        print("Stockfish safety filter: OFF (Otter only)")

    async def handle_connection(ws):
        handler = ConnectionHandler(engine)
        await handler.handle(ws)

    async def run():
        try:
            async with websockets.serve(handle_connection, WS_HOST, WS_PORT):
                await asyncio.Future()
        finally:
            if engine.sf:
                engine.sf.quit()

    asyncio.run(run())


if __name__ == "__main__":
    main()
