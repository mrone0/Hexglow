#!/usr/bin/env node
// 模拟 Riot Live Client API，供本地联调（等级触发 → 侧栏 → 截屏/OCR）。
// 用法：node scripts/mock-live.mjs --level 7 [--advance] [--port 2931]
// 配套：把打印出的 HEXGLOW_LOCKFILE 环境变量传给 `pnpm tauri dev`（仅 debug 构建读取该变量）。
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.data-cache/mock');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(flag('port', 2931));
const levels = [1, 7, 11, 15];
let level = Number(flag('level', 1));
const advance = args.includes('--advance');
const holdMs = Number(flag('hold', 12000));
const matchId = flag('match-id', '4242424242');
let gameId = Number(flag('game-id', 4242424242));

fs.mkdirSync(cache, {recursive: true});
const keyPath = path.join(cache, 'key.pem');
const certPath = path.join(cache, 'cert.pem');
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  const result = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    {stdio: 'inherit'},
  );
  if (result.status !== 0) throw new Error('openssl 生成自签名证书失败');
}
const password = 'hexglow-mock';
const lockfile = path.join(cache, 'lockfile');
fs.writeFileSync(lockfile, `LeagueClient:4242:${port}:${password}:https\n`, 'utf8');

const players = [
  ['HexglowTest', 'TEST', 'Ahri', 'ORDER'],
  ['MockTop', 'TEST', 'Garen', 'ORDER'],
  ['MockJungle', 'TEST', 'Ashe', 'ORDER'],
  ['MockMid', 'TEST', 'Lux', 'ORDER'],
  ['MockSupport', 'TEST', 'Braum', 'ORDER'],
  ['EnemyTop', 'TEST', 'Darius', 'CHAOS'],
  ['EnemyJungle', 'TEST', 'Jinx', 'CHAOS'],
  ['EnemyMid', 'TEST', 'Veigar', 'CHAOS'],
  ['EnemyAdc', 'TEST', 'Leona', 'CHAOS'],
  ['EnemySupport', 'TEST', 'Nami', 'CHAOS'],
];
// 赛后补录用：真实客户端给的是海克斯 id，这里用打包数据里认得出的 id。
const augmentIds = [1001, 1002, 1067, 1004, 1110, 1111, 1112, 1113, 1114, 1115];
const noEogAugments = args.includes('--no-eog-augments');
const ownAugmentsOf = (index) => [augmentIds[index % augmentIds.length], augmentIds[(index + 3) % augmentIds.length]];
let started = Date.now();
let phase = 'InProgress';
let cycle = 0;
const endPhase = () => ['WaitingForStats', 'PreEndOfGame', 'EndOfGame'].includes(phase);
const eogPayload = () => ({
  gameId,
  teams: ['ORDER', 'CHAOS'].map((team, teamIndex) => ({
    isWinningTeam: team === 'ORDER',
    players: players
      .map((entry, index) => ({entry, index}))
      .filter(({entry}) => entry[3] === team)
      .map(({entry, index}) => ({
        summonerId: index + 1,
        summonerName: entry[0],
        championName: entry[2],
        augments: noEogAugments ? undefined : ownAugmentsOf(index + teamIndex),
      })),
  })),
});
const historyPayload = () => ({
  games: {
    games: [
      {
        gameId,
        participants: players.map((entry, index) => ({
          summonerName: entry[0],
          championName: entry[2],
          augments: ownAugmentsOf(index),
        })),
      },
      {gameId: gameId - 1, participants: [{summonerName: 'StaleEntry', championName: 'Ahri', augments: [1001]}]},
    ],
  },
});
const payload = () => ({
  activePlayer: {
    riotId: 'HexglowTest#TEST',
    summonerName: 'HexglowTest',
    level,
    championStats: {},
    abilities: {},
    gold: {currentGold: 1200},
  },
  allPlayers: players.map(([name, tag, championName, team]) => ({
    riotId: `${name}#${tag}`,
    riotIdGameName: name,
    riotIdTagLine: tag,
    summonerName: name,
    championName,
    team,
    items: [],
    spells: [],
    runes: {},
  })),
  gameData: {
    gameId,
    gameMode: 'ARAM',
    gameTime: Number(((Date.now() - started) / 1000).toFixed(1)),
    mapName: 'Howling Abyss',
  },
  events: {Events: [{EventName: 'GameStart'}]},
  maps: {},
});

const server = https.createServer(
  {key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath)},
  (request, response) => {
    const url = request.url?.split('?')[0] ?? '';
    console.log(`${new Date().toISOString()} ${request.method} ${request.url}`);
    const send = (value) => {
      const body = JSON.stringify(value);
      response.writeHead(200, {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)});
      response.end(body);
    };
    if (url.startsWith('/liveclientdata/allgamedata')) {
      send(payload());
      return;
    }
    // LCU：结束阶段的赛后补录链路（phase → session → EOG/比赛历史 → 当前召唤师）。
    if (url === '/lol-gameflow/v1/gameflow-phase') {
      send(phase);
      return;
    }
    if (url === '/lol-gameflow/v1/session') {
      send({gameId, phase, game: {id: gameId}});
      return;
    }
    if (url === '/lol-summoner/v1/current-summoner') {
      send({summonerId: 1, displayName: 'HexglowTest', gameName: 'HexglowTest', tagLine: 'TEST', accountId: 42});
      return;
    }
    if (url === '/lol-end-of-game/v1/eog-stats-block') {
      // 与真实客户端一致：赛后大厅里 EOG 仍然可取，用来补录滑过窗口的对局。
      if (!endPhase() && phase !== 'Lobby') {
        response.writeHead(404, {'content-type': 'application/json'});
        response.end('{"error":"not-ended"}');
        return;
      }
      send(eogPayload());
      return;
    }
    if (url === '/lol-match-history/v1/products/lol/current-summoner/matches') {
      send(historyPayload());
      return;
    }
    response.writeHead(404, {'content-type': 'application/json'});
    response.end('{"error":"mock"}');
  },
);

server.listen(port, '127.0.0.1', () => {
  console.log(`mock Live Client API → https://127.0.0.1:${port}`);
  console.log(`lockfile: ${lockfile}`);
  console.log(`HEXGLOW_LOCKFILE=${lockfile}`);
  console.log(`activePlayer.level=${level}${advance ? '（每 ' + holdMs + 'ms 依次升到 7 / 11 / 15）' : ''}`);
});

if (advance) {
  const timer = setInterval(() => {
    const index = levels.indexOf(level);
    if (index >= 0 && index < levels.length - 1) {
      level = levels[index + 1];
      console.log(`mock: level → ${level}`);
      return;
    }
    // 等级走完进结束阶段 → 赛后大厅，随后开下一局：验证赛后自动补录与对局归档。
    if (phase === 'InProgress') phase = 'WaitingForStats';
    else if (phase === 'WaitingForStats') phase = 'EndOfGame';
    else if (phase === 'EndOfGame') phase = 'Lobby';
    else {
      cycle += 1;
      gameId += 1000;
      level = levels[0];
      phase = 'InProgress';
      started = Date.now();
      console.log(`mock: 新一局 gameId → ${gameId}（cycle ${cycle}）`);
      return;
    }
    console.log(`mock: phase → ${phase}`);
  }, holdMs);
}
