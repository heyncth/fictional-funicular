# History

## Goal
Integrate human-like chess move prediction into Chesshook chess.com userscript via local Python WebSocket server using Otter model.

## Architecture
```
chess.com board → userscript → WebSocket → otter_server.py → Otter model → bestmove
```

## Timeline

### In-browser ONNX (abandoned)
- Tried ORT WASM in Tampermonkey userscript
- Blocked by chess.com CSP (dynamic imports) + fetch interceptor (corrupts binary responses)
- No ORT version works in userscript context

### External server approach (current)
- Created `otter_server.py` — Python WebSocket server using `otter-chess` package
- Created `userscript-external.js` — modified abc userscript with external engine support
- Protocol: `whoareyou` → `whatengine` → `setelo` → `lock` → `sub` → `position fen` → `history` → `timecontrol` → `clock` → `go` → `bestmove`

### Key fixes
- Import: `from otter_chess import OtterModel` (not `otter`)
- `getPlayingAs()` returns undefined on first move → infer from FEN
- Elo: server randomizes offset 200-400 above opponent
- Elo swap: when opponent's turn, swap elos (Otter's player_elo = side to move)
- Clock: send both white/black fractions, server picks correct one by turn
- Probabilities: key is `probability` not `prob`

## Files
| File | Purpose |
|------|---------|
| `otter_server.py` | WebSocket server, Otter model inference |
| `userscript-external.js` | Tampermonkey userscript for chess.com |
| `requirements.txt` | `otter-chess`, `websockets` |
| `models/` | Maia ONNX models (unused) |

## Config (userscript)
| Config | Description |
|--------|-------------|
| External Engine URL | `ws://localhost:8080/ws` |
| External Engine Passkey | Auth passkey |
| Auto Move | Auto-play moves with random delay |
| Playing As | white/black/auto |
| Engine Move Color | Render color |

## Commands (server)
| Command | Format | Description |
|---------|--------|-------------|
| `setelo` | `setelo <oppoElo> <playingAs>` | Set opponent elo, server randomizes self +200-400 |
| `history` | `history <san1> <san2> ...` | Set move history (SAN) |
| `timecontrol` | `timecontrol 900+10` | Set time control |
| `clock` | `clock <whiteFrac> <blackFrac>` | Set clock fractions (0.0-1.0) |
| `position fen` | `position fen <fen>` | Set board position |
| `go` | `go` | Compute best move |

## Otter model
- Source: `peargentlabs/otter-chess` on HuggingFace
- Size: ~58MB
- Inputs: board tensor (18×8×8), last 20 moves, Elo buckets, time control, clock fraction
- Outputs: policy head (move probabilities), value head, auxiliary head
- API: `model.predict(fen, player_elo, opponent_elo, history_moves, time_control, clock_fraction, top_k)`
