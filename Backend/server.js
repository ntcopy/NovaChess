// Stockfish / UCI WebSocket bridge.
// npm install && npm start
// Env: PORT=8765, HOST=127.0.0.1, STOCKFISH_PATH=Engines/stockfish19.exe,
//      THREADS=2, HASH=256, ALLOWED_ORIGINS=chess.com,localhost,
//      TLS_CERT=/path/cert.pem, TLS_KEY=/path/key.pem
//
// Requests:
//   { type:"engine", id?, engine:"stockfish19"|"stockfish18"|"stockfish17" }
//   { type:"analyze", id?, fen, movetime?, lines?, depth? }

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { Chess } from 'chess.js';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8765;
const HOST = process.env.HOST || '127.0.0.1';
const THREADS = String(process.env.THREADS || '2');
const HASH_MB = String(process.env.HASH || '256');
const ALLOWED = (process.env.ALLOWED_ORIGINS || 'chess.com,localhost')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

const ENGINES = {
  stockfish19: {
    name: 'Stockfish 19',
    path: process.env.STOCKFISH_PATH || 'Engines/stockfish19.exe',
    args: [],
    protocol: 'uci',
    options: { Threads: THREADS, Hash: HASH_MB },
  },
  stockfish18: {
    name: 'Stockfish 18',
    path: 'Engines/stockfish18.exe',
    args: [],
    protocol: 'uci',
    options: { Threads: THREADS, Hash: HASH_MB },
  },
  stockfish17: {
    name: 'Stockfish 17',
    path: 'Engines/stockfish17.exe',
    args: [],
    protocol: 'uci',
    options: { Threads: THREADS, Hash: HASH_MB },
  },
  lc0: {
    name: 'Leela Chess Zero',
    path: 'Engines/lc0.exe',
    args: [],
    protocol: 'uci',
    options: {},
    enabled: false,
  }
};

let selectedEngine = 'stockfish19';
let engineProcess = null;
let engineReady = false;
let outputBuffer = '';
let lineHandler = () => {};
let waiters = [];
let activeJob = null;
let pendingJob = null;
let multiPv = 1;

// All switch/admission operations are serialized.
let controlQueue = Promise.resolve();

function queueControl(fn) {
  const result = controlQueue.then(fn);
  controlQueue = result.catch(() => {});
  return result;
}

function rawSend(child, command) {
  if (
    !child ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.stdin.destroyed
  ) {
    throw new Error('Engine process is not available');
  }

  child.stdin.write(`${command}\n`);
}

function waitForLine(child, expected, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (engineProcess !== child) {
      return reject(new Error('Engine was replaced'));
    }

    const waiter = {
      child,
      expected,
      resolve,
      reject,
      timer: null,
    };

    waiter.timer = setTimeout(() => {
      waiters = waiters.filter(w => w !== waiter);
      reject(new Error(`Timed out waiting for ${expected}`));
    }, timeoutMs);

    waiters.push(waiter);
  });
}

function rejectWaiters(child, error) {
  const keep = [];

  for (const waiter of waiters) {
    if (waiter.child === child) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    } else {
      keep.push(waiter);
    }
  }

  waiters = keep;
}

function dispatchLine(child, line) {
  if (engineProcess !== child) return;

  const index = waiters.findIndex(
    w => w.child === child && w.expected === line
  );

  if (index !== -1) {
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve();
  } else {
    lineHandler(line);
  }
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return resolve();
    }

    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      resolve();
    };

    child.once('close', finish);

    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }, timeoutMs);
  });
}

async function stopEngine() {
  const child = engineProcess;

  engineProcess = null;
  engineReady = false;
  outputBuffer = '';

  if (!child) return;

  rejectWaiters(child, new Error('Engine stopped'));

  console.log('Stopping previous engine...');

  try {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32' && child.pid) {
        // Kill descendants too (some engines launch helper/backend processes).
        const killer = spawn(
          'taskkill',
          ['/PID', String(child.pid), '/T', '/F'],
          {
            stdio: 'ignore',
            windowsHide: true,
          }
        );

        await new Promise(resolve => {
          killer.once('error', resolve);
          killer.once('close', resolve);
        });
      } else {
        child.kill('SIGTERM');
      }
    }
  } catch (error) {
    console.warn(`Engine termination warning: ${error.message}`);

    try {
      child.kill('SIGKILL');
    } catch {}
  }

  await waitForExit(child);

  console.log('Previous engine process exited.');
}

async function startEngine(engineId) {
  const config = ENGINES[engineId];

  if (!config) {
    throw new Error(`Unknown engine: ${engineId}`);
  }

  if (config.enabled === false) {
    throw new Error(
      `${config.name} is not configured yet (executable/weights/backend required).`
    );
  }

  await stopEngine();

  console.log(`Starting ${config.name}: ${config.path}`);

  const child = spawn(config.path, config.args || [], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });

  engineProcess = child;
  engineReady = false;
  outputBuffer = '';

  child.on('error', error => {
    rejectWaiters(child, error);

    if (engineProcess === child) {
      engineReady = false;
      console.error(`Could not start ${config.name}: ${error.message}`);
    }
  });

  child.on('exit', (code, signal) => {
    rejectWaiters(
      child,
      new Error(`${config.name} exited before initialization completed`)
    );

    if (engineProcess === child) {
      engineProcess = null;
      engineReady = false;

      console.error(
        `${config.name} exited (code=${code}, signal=${signal})`
      );
    }
  });

  child.stdout.setEncoding('utf8');

  child.stdout.on('data', chunk => {
    if (engineProcess !== child) return;

    outputBuffer += chunk;

    let index;

    while ((index = outputBuffer.indexOf('\n')) !== -1) {
      const line = outputBuffer.slice(0, index).trim();
      outputBuffer = outputBuffer.slice(index + 1);

      if (line) {
        dispatchLine(child, line);
      }
    }
  });

  try {
    if (config.protocol !== 'uci') {
      throw new Error(`Unsupported protocol: ${config.protocol}`);
    }

    const uci = waitForLine(child, 'uciok');

    rawSend(child, 'uci');

    await uci;

    for (const [name, value] of Object.entries(config.options || {})) {
      rawSend(child, `setoption name ${name} value ${value}`);
    }

    const ready = waitForLine(child, 'readyok');

    rawSend(child, 'isready');

    await ready;

    if (engineProcess !== child) {
      throw new Error('Engine was replaced during startup');
    }

    selectedEngine = engineId;
    multiPv = 1;
    engineReady = true;

    console.log(`${config.name} is ready.`);
  } catch (error) {
    if (engineProcess === child) {
      await stopEngine();
    }

    throw error;
  }
}

function switchEngine(engineId) {
  return queueControl(async () => {
    if (!ENGINES[engineId]) {
      throw new Error(`Unknown engine: ${engineId}`);
    }

    if (selectedEngine === engineId && engineReady) {
      return;
    }

    // Drop all analysis belonging to the engine being replaced.
    activeJob = null;
    pendingJob = null;

    await startEngine(engineId);
  });
}

function sendClient(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function startSearch(ws, req) {
  if (!engineReady || !engineProcess) {
    throw new Error('Engine is not ready');
  }

  activeJob = {
    ws,
    req,
    infos: new Map(),
    lastSent: 0,
  };

  if (req.lines !== multiPv) {
    rawSend(engineProcess, `setoption name MultiPV value ${req.lines}`);
    multiPv = req.lines;
  }

  rawSend(engineProcess, `position fen ${req.fen}`);

  rawSend(
    engineProcess,
    req.depth
      ? `go depth ${req.depth} movetime ${req.movetime}`
      : `go movetime ${req.movetime}`
  );
}

function enqueueAnalysis(ws, req) {
  if (!engineReady) {
    throw new Error('Engine is not ready; retry when the engine is ready.');
  }

  if (!activeJob) {
    startSearch(ws, req);
  } else {
    // Latest waiting request replaces the previous one.
    pendingJob = { ws, req };

    rawSend(engineProcess, 'stop');
  }
}

function toSan(fen, pv, limit = 8) {
  const san = [];

  try {
    const game = new Chess(fen);

    for (const uci of pv.slice(0, limit)) {
      const move = game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        ...(uci.length === 5
          ? { promotion: uci[4] }
          : {}),
      });

      if (!move) break;

      san.push(move.san);
    }
  } catch {}

  return san.length ? san : null;
}

function linesOf(job) {
  return [...job.infos.values()]
    .sort((a, b) => a.rank - b.rank)
    .map(info => {
      const move = info.pv[0];

      if (!move || move.length < 4) {
        return null;
      }

      return {
        rank: info.rank,
        move,
        from: move.slice(0, 2),
        to: move.slice(2, 4),
        promotion: move.length === 5 ? move[4] : null,
        depth: info.depth,
        score: info.score,
        pv: info.pv.slice(0, 8),
        pvSan: toSan(job.req.fen, info.pv),
      };
    })
    .filter(Boolean);
}

lineHandler = line => {
  if (line.startsWith('info ')) {
    if (!activeJob || / (lowerbound|upperbound) /.test(line)) {
      return;
    }

    const match = line.match(
      /(?:^| )depth (\d+).*?score (cp|mate) (-?\d+).*? pv (.+)$/
    );

    if (!match) return;

    const rank = Number(
      line.match(/(?:^| )multipv (\d+)/)?.[1] ?? 1
    );

    const pv = match[4].trim().split(/\s+/);

    if (!pv[0]) return;

    activeJob.infos.set(rank, {
      rank,
      depth: Number(match[1]),
      score: {
        type: match[2],
        value: Number(match[3]),
      },
      pv,
    });

    const now = Date.now();

    if (now - activeJob.lastSent >= 120) {
      activeJob.lastSent = now;

      sendClient(activeJob.ws, {
        type: 'info',
        id: activeJob.req.id ?? null,
        fen: activeJob.req.fen,
        lines: linesOf(activeJob),
      });
    }

    return;
  }

if (line.startsWith('bestmove')) {
  console.log('[bridge] bestmove received:', line);
  console.log('[bridge] activeJob exists:', !!activeJob);
  console.log('[bridge] pendingJob exists:', !!pendingJob);

  const completed = activeJob;
  activeJob = null;

  if (pendingJob) {
    const next = pendingJob;
    pendingJob = null;

    console.log('[bridge] Starting pending job:', next.req.id);

    if (
      next.ws.readyState === next.ws.OPEN &&
      engineReady
    ) {
      try {
        startSearch(next.ws, next.req);
      } catch (error) {
        console.error('[bridge] Pending search failed:', error);

        sendClient(next.ws, {
          type: 'error',
          id: next.req.id ?? null,
          message: error.message,
        });
      }
    }

    return;
  }

  if (!completed) {
    console.error('[bridge] No active job for bestmove; discarding');
    return;
  }

  const move = line.split(/\s+/)[1];
  const valid = move && move !== '(none)' && move !== '0000';
  const lines = linesOf(completed);

  const response = {
    type: 'bestmove',
    id: completed.req.id ?? null,
    fen: completed.req.fen,
    move: valid ? move : null,
    from: valid ? move.slice(0, 2) : null,
    to: valid ? move.slice(2, 4) : null,
    promotion: valid && move.length === 5 ? move[4] : null,
    depth: lines[0]?.depth,
    score: lines[0]?.score,
    pv: lines[0]?.pv,
    lines,
  };

  sendClient(completed.ws, response);
}
};

function validFen(fen) {
  if (
    typeof fen !== 'string' ||
    fen.length > 120 ||
    /[\r\n\0]/.test(fen)
  ) {
    return false;
  }

  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

const verifyClient = ({ origin }) => {
  if (!origin) return true;

  try {
    const hostname = new URL(origin).hostname.toLowerCase();

    return ALLOWED.some(
      domain =>
        hostname === domain ||
        hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
};

let httpsServer = null;
let wss;

if (process.env.TLS_CERT && process.env.TLS_KEY) {
  httpsServer = createServer({
    cert: readFileSync(process.env.TLS_CERT),
    key: readFileSync(process.env.TLS_KEY),
  });

  wss = new WebSocketServer({
    server: httpsServer,
    verifyClient,
  });

  httpsServer.listen(PORT, HOST);
} else {
  wss = new WebSocketServer({
    port: PORT,
    host: HOST,
    verifyClient,
  });
}

const scheme = httpsServer ? 'wss' : 'ws';

console.log(
  `Engine bridge listening on ${scheme}://${HOST}:${PORT}`
);

wss.on('connection', ws => {
  const fail = (message, id = null) => {
    sendClient(ws, {
      type: 'error',
      id,
      message,
    });
  };

  ws.on('message', async data => {
    let req;

    try {
      req = JSON.parse(data.toString());
    } catch {
      fail('Invalid JSON');
      return;
    }

    if (
      !req ||
      typeof req !== 'object' ||
      Array.isArray(req)
    ) {
      fail('Request must be a JSON object');
      return;
    }

    if (req.type === 'engine') {
      if (
        typeof req.engine !== 'string' ||
        !ENGINES[req.engine]
      ) {
        fail(`Unknown engine: ${req.engine}`, req.id ?? null);
        return;
      }

      try {
        await switchEngine(req.engine);

        sendClient(ws, {
          type: 'engine',
          id: req.id ?? null,
          engine: selectedEngine,
          name: ENGINES[selectedEngine].name,
          status: 'ready',
        });
      } catch (error) {
        fail(
          `Engine switch failed: ${error.message}`,
          req.id ?? null
        );
      }

      return;
    }

    if (req.type !== 'analyze') {
      fail('Unknown request type', req.id ?? null);
      return;
    }

    if (!validFen(req.fen)) {
      fail('Invalid FEN', req.id ?? null);
      return;
    }

    const movetime = Math.min(
      Math.max(Number(req.movetime) || 1000, 50),
      15000
    );

    const lines = Math.min(
      Math.max(Math.round(Number(req.lines)) || 1, 1),
      5
    );

    const depth =
      req.depth == null
        ? null
        : Math.min(
            Math.max(Math.round(Number(req.depth)) || 1, 1),
            40
          );

    const analysis = {
      id: req.id,
      fen: req.fen,
      movetime,
      lines,
      depth,
    };

    try {
      // Requests arriving during a switch wait behind it,
      // preserving message order.
      await queueControl(async () => {
        enqueueAnalysis(ws, analysis);
      });
    } catch (error) {
      fail(error.message, req.id ?? null);
    }
  });

  ws.on('close', () => {
    if (pendingJob?.ws === ws) {
      pendingJob = null;
    }

    if (
      activeJob?.ws === ws &&
      engineReady &&
      engineProcess
    ) {
      try {
        rawSend(engineProcess, 'stop');
      } catch {}
    }
  });
});

async function shutdown() {
  console.log('Shutting down bridge...');

  wss.close();

  if (httpsServer) {
    httpsServer.close();
  }

  activeJob = null;
  pendingJob = null;

  await stopEngine();

  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);