# Memory budget

Target host: 8 GB. Gate: five agents with full tools, concurrent, peak PSS of the daemon and every descendant
< 2048 MB. MCP servers are separate child processes and are not part of the daemon's measured PSS; budget them
separately.

Measured: benchmark 5/5 completed, 4.6 s wall, **247 MB peak PSS**, p95 191 MB, p50 105 MB. The harness opens at
about 130 MB RSS on an empty database.

Task per agent: eight tool rounds alternating a 300k-iteration shell loop, a 20 KiB file write, a read, and a memory
note, then a final answer. The faux provider is paced at 1M tokens/s so the run measures memory, not streaming.

Levers:

- Run limiter 5 active / 20 queued; queue position is reported to Telegram.
- Prune reads the session index once, writes it once, and purges one transcript at a time.
- Retention soft-deletes at 3 days, purges tombstones 3 days later and vacuums; one memory summary per agent is
  written before the batch, not one note per thread.
- Harness: partial 250 ms, output 400 ms, context retention 30 s, document retention 60 s.
- Code mode sandbox 128 MB; one Chromium, idle close; one Photon worker.
- Bounded render caches; watchers only for conversations with an active chat.
- Provider catalog loaded only by the CLI; one provider module per configured provider in the daemon.
- systemd MemoryHigh 1700M, MemoryMax 2G, MemorySwapMax 1G; Node heap 1400 MB, semi-space 16 MB.

`dura tune` detects zram and sysctl state first and only writes values that are still at kernel defaults.
