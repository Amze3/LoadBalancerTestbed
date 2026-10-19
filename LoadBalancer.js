import * as http from "http"
import crypto from "crypto"

import ServerFactory from "./ServerFactory.js"
import Utils from "./Util.js"
// import RoundRobin from "./RoundRobin.js"
// import LeastConnections from "./LeastConnections.js"
// import ConsistentHashing from "./ConsistentHashing.js"

const host = '127.0.0.1'
const port = Number(process.env.PORT) || 8080
const faultToleranceEnabled = process.env.FAULT_TOLERANCE !== "off"
// ===== ABUSE DEFENCES: enabled by default; disable only for local comparison =====
const abuseDefencesEnabled = process.env.ABUSE_DEFENCES !== "off"
const maxRequestBodyBytes = 1024
const rateLimitWindowMs = 1000
const maxRequestsPerWindow = 5

var configuration = undefined
var serverFactory = undefined
var loadBalancingAlgorithm = undefined


export default class LoadBalancer {

    constructor(configuration_) {
        this.rateLimitBuckets = new Map()
        configuration = configuration_

        if (Utils.getAlgorithm(configuration.LoadBalancingAlgorithm) === Utils.Algorithm.RoundRobin) {
            loadBalancingAlgorithm = new RoundRobin(configuration.NoServers)
        }
        else if (Utils.getAlgorithm(configuration.LoadBalancingAlgorithm)  === Utils.Algorithm.LeastConnections) {
            loadBalancingAlgorithm = new LeastConnections()
        }
        else if (Utils.getAlgorithm(configuration.LoadBalancingAlgorithm)  === Utils.Algorithm.ConsistentHashing) {
            loadBalancingAlgorithm = new ConsistentHashing(configuration.NoServers, configuration.Replicas)
        }

        let httpserver = http.createServer(
            async (req, res) => {
                res.setHeader("Content-Type", "text/plain");
                const requestUrl = new URL(req.url, `http://${host}:${port}`)

                if (requestUrl.pathname === "/") {
                    res.writeHead(200);
                    res.end(`LoadBalancer is running on http://${host}:${port}/\n\nTo make a session request - http://${host}:${port}/[request]`);
                    return
                }

                // ===== FAULT TOLERANCE: local-only test controls =====
                if (requestUrl.pathname === "/__test/status") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify(serverFactory.getHealthStatus()));
                    return
                }

                // ===== ABUSE DEFENCES: local test configuration endpoint =====
                if (requestUrl.pathname === "/__test/defences") {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        enabled: abuseDefencesEnabled,
                        maxRequestBodyBytes,
                        maxRequestsPerWindow,
                        rateLimitWindowMs
                    }));
                    return
                }

                const failureMatch = requestUrl.pathname.match(/^\/__test\/fail\/(S\d+)$/)
                if (failureMatch) {
                    const durationMs = Number(requestUrl.searchParams.get("durationMs"))
                    const started = serverFactory.simulateFailure(failureMatch[1], durationMs)
                    res.writeHead(started ? 202 : 400);
                    res.end(started
                        ? `${failureMatch[1]} unavailable for ${durationMs} ms`
                        : "Unknown server or invalid duration (use 1000-30000 ms)");
                    return
                }

                // ===== ABUSE DEFENCES: reject oversized bodies and burst traffic =====
                if (abuseDefencesEnabled) {
                    const bodyWithinLimit = await this.checkRequestBodySize(req, res)
                    if (!bodyWithinLimit) return

                    if (!this.allowRequest(req.socket.remoteAddress)) {
                        req.resume()
                        res.writeHead(429)
                        res.end("Request denied - rate limit exceeded")
                        return
                    }
                } else {
                    req.resume()
                }

                this.handleSessionRequest(requestUrl.pathname, res)
            }
        );
        // ===== ABUSE DEFENCES: bound slow/incomplete incoming requests =====
        if (abuseDefencesEnabled) {
            httpserver.requestTimeout = 5000
            httpserver.headersTimeout = 6000
        }
        httpserver.listen(port, host, () => {
            console.log(`LoadBalancer is running on http://${host}:${port}`)

            serverFactory = new ServerFactory(faultToleranceEnabled)
            serverFactory.createServers(configuration)
        });

    }

    // ===== ABUSE DEFENCES: bound request-body memory before processing =====
    checkRequestBodySize(req, res) {
        const contentLength = Number(req.headers["content-length"] || 0)
        if (contentLength > maxRequestBodyBytes) {
            req.resume()
            res.writeHead(413)
            res.end("Request denied - payload too large")
            return Promise.resolve(false)
        }

        return new Promise(resolve => {
            let totalBytes = 0
            let rejected = false
            req.on("data", chunk => {
                totalBytes += chunk.length
                if (totalBytes > maxRequestBodyBytes && !rejected) {
                    rejected = true
                    res.writeHead(413)
                    res.end("Request denied - payload too large")
                }
            })
            req.on("end", () => resolve(!rejected))
            req.on("error", error => {
                console.error("Request body read failed:", error.message)
                if (!res.headersSent) {
                    res.writeHead(400)
                    res.end("Request denied - invalid request body")
                }
                resolve(false)
            })
        })
    }

    // ===== ABUSE DEFENCES: fixed-window per-client request limit =====
    allowRequest(clientAddress) {
        const now = Date.now()
        const current = this.rateLimitBuckets.get(clientAddress)
        if (!current || now - current.startedAt >= rateLimitWindowMs) {
            this.rateLimitBuckets.set(clientAddress, { startedAt: now, count: 1 })
            return true
        }
        if (current.count >= maxRequestsPerWindow) return false
        current.count++
        return true
    }

    // ===== FAULT TOLERANCE: skip unhealthy servers and retry another backend =====
    handleSessionRequest(requestPath, res, attempted = []) {
        const preferredServer = loadBalancingAlgorithm.getNext(requestPath)
        const serverId = faultToleranceEnabled
            ? serverFactory.getHealthyServerIndex(preferredServer, attempted)
            : `${preferredServer}`

        if (!serverId || !serverFactory.servers.has(serverId)) {
            res.writeHead(503);
            res.end("Session ACCESS DENIED - No healthy servers available");
            return
        }

        attempted.push(serverId)
        const backendRequest = http.get(`${serverFactory.getServerName(serverId)}/start`, backendResponse => {
            if (faultToleranceEnabled && backendResponse.statusCode >= 500) {
                backendResponse.resume()
                serverFactory.markUnhealthy(serverId)
                this.handleSessionRequest(requestPath, res, attempted)
                return
            }

            res.writeHead(backendResponse.statusCode || 200)
            backendResponse.pipe(res)
        })

        // ===== ABUSE DEFENCES: cap time spent waiting for a backend =====
        if (abuseDefencesEnabled) {
            backendRequest.setTimeout(2000, () => backendRequest.destroy(new Error("Backend request timed out")))
        }
        backendRequest.on("error", () => {
            if (faultToleranceEnabled) {
                serverFactory.markUnhealthy(serverId)
                this.handleSessionRequest(requestPath, res, attempted)
            } else {
                res.writeHead(503)
                res.end("Session ACCESS DENIED - Backend unavailable")
            }
        })
    }
}


class LeastConnections {
    constructor() {
        this.next = -1
    }

    getNext() {
        this.next = serverFactory.getServerWithMinConnectionsIndex()
        return this.next
    }
}

class RoundRobin {
    constructor(max) {
        this.next = -1
        this.max = max
    }

    getNext() {
        this.next = this.next + 1

        if (this.next >= this.max) {
            this.next = 0
        }
        return `S${this.next}`
    }
}

class ConsistentHashing {
    constructor(noservers_, replicas_) {
        this.noservers = noservers_
        this.replicas = replicas_
        this.hashmap = new Map()
      
        for (let i = 0; i < this.replicas; i++) {// replica
            for (let j = 0; j < this.noservers; j++) {

                let server_hash = crypto.createHash('md5').update(`__S${j}${i}`).digest('hex');
                this.hashmap.set(`__S${j}${i}`,server_hash)
            }
        }
    }

    addClient(requestid){
        if(!this.hashmap.has(requestid)){
            let request_hash = crypto.createHash('md5').update(requestid).digest('hex');
            this.hashmap.set(requestid,request_hash)
        }        
    }

    removeNode(nodeid){
        this.hashmap.delete(nodeid)
    }

    getNext(requestid){
        this.addClient(requestid)

        let serverid = undefined
        //sort by hashkeys
        const hashmap_sorted = new Map([...this.hashmap.entries()].sort((a, b) => a[1].localeCompare(b[1])));
        
        let rfound = false
        for (let [key, value] of hashmap_sorted) {
            if(key === requestid){
                rfound = true
            }

            if(rfound){
                if(key.startsWith("__S")){
                    serverid = removeN(key,2)
                    if(this.noservers < 10){
                        serverid = serverid.substring(0, 2);
                    }
                    else if(this.noservers <100){
                        serverid = serverid.substring(0, 3);
                    }
                    else if(this.noservers <1000){
                        serverid = serverid.substring(0, 4);
                    }//max of 999 servers

                    break
                }
            }
        }

        return serverid
    }

}

//util functions
const removeN = (str, num) => {
    const { length } = str;
    if(num > length){
       return str;
    };
    const newStr = str.substr(num, length - num);
    return newStr;
 };
