# Load-Balancing Testbed

A small Node.js testbed for routing requests across application servers and
datastores. It supports Round Robin, Least Connections, and Consistent Hashing.
The experiments explore capacity, backend failure recovery, and basic defences
against abusive traffic. Tests run locally; they do not simulate production-scale
traffic or network-level DDoS.

## Run

Requirements: Node.js 18 or newer.

```powershell
npm install
node MainTerminal.js
```

Choose `Y` to start the load balancer. In a second terminal, run a workload:

```powershell
node RequestSimulation.js
```

Stop the server with `Ctrl+C`. To choose a repeatable Task A configuration,
set `CONFIG_PRESET` before starting, for example:

```powershell
$env:CONFIG_PRESET = "fourServers"
node MainTerminal.js
```

Available presets and experiment results are in [Task A configurations and
results](./Configs%20effectivness.md).

## More detail

- [Task A configurations and results](./Configs%20effectivness.md)
- [Task B fault tolerance, abuse defences, and results](./Task-B-Results.md)

## Recorded results

- **Task A baseline:** 186/320 requests succeeded (58.1%).
- **Task B fault test:** 23/29 succeeded with failover off; 29/29 with failover
  on during the tested backend outage.
- **Task B traffic test:** 8/12 legitimate requests served with defences off;
  9/12 with defences on. Defences rejected 9/14 simulated abusive requests.
