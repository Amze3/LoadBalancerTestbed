import * as http from "http"
import findFreePorts from "find-free-ports"
import Server from "./Server.js"
import DatabaseFactory from "./DatabaseFactory.js"
import Utils from "./Util.js"

const host = '127.0.0.1'
var configuration = undefined

export default class ServerFactory {

    constructor(enableFaultTolerance = true) {
        this.enableFaultTolerance = enableFaultTolerance
        this.servers = new Map()
        // ===== FAULT TOLERANCE: health state and simulated failure timers =====
        this.healthyServers = new Map()
        this.failureTimers = new Map()
    }

    getServers() {
        return this.servers
    }
    getServerName(index){
        return this.servers.get(`${index}`).name
    }

    // ===== FAULT TOLERANCE: select only health-checked backends =====
    getHealthyServerIndex(preferredIndex, excluded = []) {
        const preferred = `${preferredIndex}`
        if (this.healthyServers.get(preferred) && !excluded.includes(preferred)) {
            return preferred
        }

        for (const id of this.servers.keys()) {
            if (this.healthyServers.get(id) && !excluded.includes(id)) {
                return id
            }
        }

        return undefined
    }

    markUnhealthy(serverId) {
        if (this.healthyServers.has(serverId)) {
            this.healthyServers.set(serverId, false)
        }
    }

    getServerWithMinConnectionsIndex(){
        let minkey = undefined
        let minsessions = Infinity

        for (let [key, server] of this.servers) {
            if(this.healthyServers.get(key) && server.getNoSessions() < minsessions){
                minkey = key
                minsessions = server.getNoSessions() 
            }
        }
        return minkey
    }

    // ===== FAULT TOLERANCE: health checks and local failure simulation =====
    async checkHealth() {
        for (const [id, server] of this.servers) {
            const healthy = await new Promise(resolve => {
                const request = http.get(`${server.name}/health`, response => {
                    response.resume()
                    resolve(response.statusCode === 200)
                })

                request.setTimeout(1000, () => request.destroy());
                request.on("error", () => resolve(false))
            })

            const wasHealthy = this.healthyServers.get(id)
            this.healthyServers.set(id, healthy)
            if (wasHealthy !== healthy) {
                console.log(`Health check: ${id} is ${healthy ? "healthy" : "unhealthy"}`)
            }
        }
    }

    simulateFailure(serverId, durationMs) {
        const server = this.servers.get(serverId)
        if (!server || !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30000) {
            return false
        }

        const previousTimer = this.failureTimers.get(serverId)
        if (previousTimer) {
            clearTimeout(previousTimer)
        }

        server.setAvailable(false)
        this.healthyServers.set(serverId, false)
        const timer = setTimeout(() => {
            server.setAvailable(true)
            this.failureTimers.delete(serverId)
            console.log(`Simulated failure ended: ${serverId} is available for health checks`)
        }, durationMs)
        this.failureTimers.set(serverId, timer)
        console.log(`Simulated failure started: ${serverId} unavailable for ${durationMs} ms`)
        return true
    }

    getHealthStatus() {
        return {
            faultToleranceEnabled: this.enableFaultTolerance,
            servers: Object.fromEntries(
                [...this.servers].map(([id, server]) => [
                    id,
                    this.enableFaultTolerance
                        ? this.healthyServers.get(id) === true
                        : server.isAvailable()
                ])
            )
        }
    }

    async createServers(configuration_) {
        configuration = configuration_
        DatabaseFactory.createDatabases(configuration)

        let freeports = await findFreePorts(configuration.NoServers);

        for (let i = 0; i < freeports.length; i++) {
            let port = freeports[i]

            let maxSessions = Utils.getRandomInt(configuration.MinNoSessionsPerServer, configuration.MaxNoSessionsPerServer)
            let processTime = Utils.getRandomInt(configuration.MinProcessingTime, configuration.MaxProcessingTime) 

            let server = new Server(`S${i}`,`http://${host}:${port}`, maxSessions, processTime)
            this.servers.set(`S${i}`, server)
            this.healthyServers.set(`S${i}`, true)

            let httpserver = http.createServer(
                async function (req, res) {
                    res.setHeader("Content-Type", "application/json");
                    if (req.url === "/health") {
                        res.writeHead(server.isAvailable() ? 200 : 503);
                        res.end(server.isAvailable() ? "healthy" : "unavailable");
                        return
                    }

                    if (!server.isAvailable()) {
                        res.writeHead(503);
                        res.end(`Server ${server.id} is unavailable`);
                        return
                    }

                    if (req.url === "/") {
                        res.writeHead(200);
                        res.end(`Server ${i} is running on http://${host}:${port}`);
                        return
                    }

                    res.writeHead(200);
                    let requestPayloadRange = Utils.getRandomInt(configuration.MinSizeRequestPayload, configuration.MaxSizeRequestPayload)
                    let saved = await DatabaseFactory.savePayloadToDatastore(requestPayloadRange)
                    if (saved) {
                        let ip = req.connection.remoteAddress
                        let success = await server.addSession(ip)
                        if (success) {
                            res.end(`Session ACCESS GRANTED on http://${host}:${port}`);
                        } else {
                            res.end(`Session ACCESS DENIED on http://${host}:${port} - No server available`);
                        }
                    } else {
                        res.end(`Session ACCESS DENIED on http://${host}:${port} - request space of ${requestPayloadRange}MB is not available in datastore`);
                    }
                }
            );
            httpserver.listen(port, host, () => {
                console.log(server)
            });

        }

        // ===== FAULT TOLERANCE: periodically detect unavailable backends =====
        if (this.enableFaultTolerance) {
            this.healthCheckTimer = setInterval(() => this.checkHealth(), 1000)
        }
        this.statusTimer = setInterval(() => {
            this.showServersStatus()
            DatabaseFactory.showDatabasesStatus()
        }, 4000)
    }

    showServersStatus() {
        function review(value, key, map) {
            let serverstatus = value.getStatus()
            console.log(serverstatus)
        }
        this.servers.forEach(review);
    }
}
