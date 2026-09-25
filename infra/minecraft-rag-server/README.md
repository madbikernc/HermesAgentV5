# hermes-minecraft-rag — install checklist

**Version:** 1.0.1

Lets Minecraft bots that don't run on spark use the fleet's one shared RAG store (index,
embedder and memory directory all live on spark). Only spark runs this service. spark2's
bot units set `MC_RAG_URL=http://10.129.1.15:8105`, so `services/minecraft-bots/rag-backend.js`
sends search, indexing and note/skill reads and writes here instead of running locally.

- **Server:** `tools/hermes-minecraft-rag-server.py`. It binds spark's LAN address only
  (`10.129.1.15:8105`) and requires the `memory-token` Vaultwarden secret as a bearer token,
  the same secret every bot already loads. Paths are restricted to `world/`, `bots/<name>/` and
  `skills/`, ending in `.md` or `.json`.
- **Tests:** `services/minecraft-bots/tests/test_rag_server.py`.

```bash
# on spark
sudo cp infra/minecraft-rag-server/hermes-minecraft-rag.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hermes-minecraft-rag.service
# on spark2, after pulling (the bot units carry MC_RAG_URL)
for b in bob nell wade dale; do sudo cp infra/minecraft-bots/minecraft-bot-$b.service /etc/systemd/system/; done
sudo systemctl daemon-reload && sudo systemctl restart minecraft-bot-{bob,nell,wade,dale}
```

spark's firewall allows 8105/tcp from spark-2 (10.129.1.17) only:
`sudo ufw allow from 10.129.1.17 to any port 8105 proto tcp comment "hermes-minecraft-rag: spark-2 bots"`.

Verify on spark2 with `journalctl -u 'minecraft-bot-*' --since -10min | grep -c "search failed"`,
which should stay at 0.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-09-25 | Initial service for spark2's RAG lookup. |
| 1.0.1 | 2026-09-25 | Documented the ufw rule spark needs for spark-2. |
