'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

const CONFIG = {
  apiBase: 'https://yoyaku.collaborationtours.com',
  referer: 'https://www3.collaborationtours.com/fujirock/tour/',
  departureDate: process.env.DEPARTURE_DATE || '2026-07-23',
  adults: Number(process.env.ADULTS || 2),
  languageId: Number(process.env.LANGUAGE_ID || 82),
  intervalMs: Number(process.env.CHECK_INTERVAL_MS || 300000),
  stateFile: path.resolve(ROOT, process.env.STATE_FILE || 'state/availability-state.json'),
  plans: [
    {
      kind: 'inventory',
      key: 'naeba-prince-hotel-0405',
      name: '苗場プリンスホテル 4泊5日',
      tourCode: 'FRFSTPH2026',
      itineraryCode: '0405',
      url: 'https://yoyaku.collaborationtours.com/plan/FRFSTPH2026/0405/?site=fujirock'
    },
    {
      kind: 'inventory',
      key: 'naeba-asagai-minshuku-0405',
      name: '苗場・浅貝エリア（民宿） 4泊5日',
      tourCode: 'FRFSTASA2026',
      itineraryCode: '0405',
      url: 'https://yoyaku.collaborationtours.com/plan/FRFSTASA2026/0405/?site=fujirock'
    },
    {
      kind: 'bus-seat',
      key: 'echigoyuzawa-fast-bus',
      name: '予約制・越後湯沢ファストバス',
      tourCode: 'FRFACCESS26YUZAWA',
      itineraryCode: '0001',
      departureDates: ['2026-07-24', '2026-07-25', '2026-07-26'],
      excludedBusSeats: [
        { departureDate: '2026-07-24', id: 1866 }
      ],
      adults: 1,
      url: 'https://yoyaku.collaborationtours.com/plan/FRFACCESS26YUZAWA/0001?site=fujirock/'
    }
  ]
};

async function main() {
  const args = process.argv.slice(2);
  if (args.indexOf('--dry-run') !== -1) {
    process.env.DRY_RUN = 'true';
  }

  if (args.indexOf('--test-line') !== -1) {
    await sendLine('FUJI ROCK空き通知の送信テストです。');
    console.log('LINE test message sent.');
    return;
  }

  if (args.indexOf('--once') !== -1) {
    await runOnce();
    return;
  }

  console.log('FUJI ROCK watcher started.');
  console.log(`Interval: ${CONFIG.intervalMs}ms`);
  await runOnce();
  setInterval(function () {
    runOnce().catch(function (error) {
      console.error(`[${new Date().toISOString()}] check failed:`, error.message);
    });
  }, CONFIG.intervalMs);
}

async function runOnce() {
  const state = readState(CONFIG.stateFile);
  const results = [];

  for (const plan of CONFIG.plans) {
    const planResults = await checkPlan(plan);
    planResults.forEach(function (result) {
      results.push(result);
      console.log(formatStatus(result));
    });
  }

  const notifications = results.filter(function (result) {
    if (isTruthy(process.env.NOTIFY_EVERY_AVAILABLE)) {
      return result.available;
    }
    const previous = state[result.key];
    return shouldNotify(result, previous);
  });

  for (const result of notifications) {
    if (isTruthy(process.env.DRY_RUN)) {
      console.log(`DRY RUN LINE notification skipped: ${result.name}`);
    } else {
      await sendLine(buildMessage(result));
      console.log(`LINE notified: ${result.name}`);
    }
  }

  const nextState = {};
  results.forEach(function (result) {
    nextState[result.key] = {
      available: result.available,
      remainingInventory: result.remainingInventory,
      selectableBusSeats: result.selectableBusSeats,
      checkedAt: result.checkedAt
    };
  });
  if (isTruthy(process.env.DRY_RUN)) {
    console.log('DRY RUN state file not written.');
  } else {
    writeState(CONFIG.stateFile, nextState);
  }
}

async function checkPlan(plan) {
  if (plan.kind === 'bus-seat') {
    return checkBusSeatPlan(plan);
  }
  return [await checkInventoryPlan(plan)];
}

async function checkInventoryPlan(plan) {
  const detail = await getPlanDetail(plan);
  const itineraryId = detail.id;
  const departureDate = plan.departureDate || CONFIG.departureDate;
  const adults = Number(plan.adults || CONFIG.adults);
  const searchResult = await searchReservation(itineraryId, departureDate, adults);
  const remainingInventory = getAvailableInventory(searchResult);

  return {
    key: plan.key,
    kind: plan.kind || 'inventory',
    name: plan.name,
    url: plan.url,
    tourCode: plan.tourCode,
    itineraryCode: plan.itineraryCode,
    departureDate: departureDate,
    adults: adults,
    itineraryId: itineraryId,
    remainingInventory: remainingInventory,
    available: remainingInventory > 0,
    checkedAt: new Date().toISOString()
  };
}

async function checkBusSeatPlan(plan) {
  const detail = await getPlanDetail(plan);
  const itineraryId = detail.id;
  const adults = Number(plan.adults || CONFIG.adults);
  const results = [];

  for (const departureDate of plan.departureDates) {
    const searchResult = await searchReservation(itineraryId, departureDate, adults);
    const selectableBusSeats = getSelectableBusSeats(searchResult, plan, departureDate);

    results.push({
      key: `${plan.key}-${departureDate}`,
      kind: plan.kind,
      name: plan.name,
      url: getBookingUrl(itineraryId, departureDate),
      planUrl: plan.url,
      tourCode: plan.tourCode,
      itineraryCode: plan.itineraryCode,
      departureDate: departureDate,
      adults: adults,
      itineraryId: itineraryId,
      remainingInventory: selectableBusSeats.length,
      selectableBusSeats: selectableBusSeats,
      available: selectableBusSeats.length > 0,
      checkedAt: new Date().toISOString()
    });
  }

  return results;
}

function getPlanDetail(plan) {
  const query = {
    code: plan.tourCode,
    tourItineraryCode: plan.itineraryCode
  };
  return requestJson('GET', CONFIG.apiBase + '/user-api/spice/tour/integrate/tours/planDetail', query);
}

function searchReservation(itineraryId, departureDate, adults) {
  const payload = {
    tourItineraryId: itineraryId,
    departureDate: departureDate,
    languageId: CONFIG.languageId,
    tourReservationNumbers: [
      {
        userTypeId: 1,
        reservationRoomNumber: 1,
        numberReservation: adults,
        useUsers: adults
      }
    ]
  };

  return requestJson(
    'POST',
    CONFIG.apiBase + '/user-api/spice/resv/integrate/norm/tour-reservations/tour-basic-plan/search',
    null,
    payload
  );
}

function getAvailableInventory(searchResult) {
  let available = Number(
    searchResult &&
    searchResult.tourItinerary &&
    searchResult.tourItinerary.remainingInventory
  ) || 0;

  const roomClasses = searchResult && Array.isArray(searchResult.tourHotelRoomClasses)
    ? searchResult.tourHotelRoomClasses
    : [];

  roomClasses.forEach(function (roomClass) {
    if (!roomClass || roomClass.isAvailable === false) return;
    if (roomClass.tourBasicPlan && roomClass.tourBasicPlan.isDisplayFront === false) return;
    if (roomClass.reservationTypeCode === 'NONE') return;

    const directRemaining = Number(roomClass.remainingInventory) || 0;
    if (directRemaining > available) available = directRemaining;

    const inventories = Array.isArray(roomClass.inventories) ? roomClass.inventories : [];
    inventories.forEach(function (inventory) {
      if (!inventory || inventory.isActive === false) return;
      const remaining = (Number(inventory.quantity) || 0) - (Number(inventory.occupied) || 0);
      if (remaining > available) available = remaining;
    });
  });

  return Math.max(available, 0);
}

function getSelectableBusSeats(searchResult, plan, departureDate) {
  const busSeats = searchResult && Array.isArray(searchResult.tourBusSeatClasses)
    ? searchResult.tourBusSeatClasses
    : [];

  return busSeats
    .filter(function (busSeat) {
      if (!busSeat || busSeat.isAvailable === false) return false;
      if (busSeat.tourBasicPlan && busSeat.tourBasicPlan.isDisplayFront === false) return false;
      if (busSeat.reservationTypeCode === 'NONE') return false;
      if (busSeat.purchaseContract && busSeat.purchaseContract.isCheckBooking === true) return false;
      if (isExcludedBusSeat(plan, departureDate, busSeat)) return false;
      return true;
    })
    .map(function (busSeat) {
      return {
        id: busSeat.id,
        name: getI18nName(busSeat.busRouteClass) ||
          (busSeat.purchaseContract && busSeat.purchaseContract.name) ||
          `busSeat:${busSeat.id}`,
        reservationTypeCode: busSeat.reservationTypeCode,
        remainingInventory: Number(busSeat.remainingInventory),
        departureTime: getFirstTime(busSeat.busBoardings, 'departureTime'),
        arrivalTime: getFirstTime(busSeat.busStops, 'departureTime')
      };
    });
}

function isExcludedBusSeat(plan, departureDate, busSeat) {
  const excludedBusSeats = Array.isArray(plan.excludedBusSeats)
    ? plan.excludedBusSeats
    : [];

  return excludedBusSeats.some(function (excluded) {
    return excluded &&
      excluded.departureDate === departureDate &&
      Number(excluded.id) === Number(busSeat.id);
  });
}

function shouldNotify(result, previous) {
  if (!result.available) return false;
  if (!previous || previous.available !== true) return true;

  if (result.kind === 'bus-seat') {
    return getBusSeatIds(result.selectableBusSeats).join(',') !==
      getBusSeatIds(previous.selectableBusSeats).join(',');
  }

  return false;
}

function getBusSeatIds(busSeats) {
  return (Array.isArray(busSeats) ? busSeats : [])
    .map(function (busSeat) { return Number(busSeat.id); })
    .filter(function (id) { return !Number.isNaN(id); })
    .sort(function (a, b) { return a - b; });
}

function getI18nName(value) {
  return value &&
    value.i18ns &&
    value.i18ns[String(CONFIG.languageId)] &&
    value.i18ns[String(CONFIG.languageId)].name;
}

function getFirstTime(items, key) {
  if (!Array.isArray(items) || !items[0]) return '';
  return items[0][key] || '';
}

function getBookingUrl(itineraryId, departureDate) {
  return `${CONFIG.apiBase}/booking/plan/setting/${itineraryId}/${departureDate.replace(/-/g, '')}/`;
}

function requestJson(method, urlString, query, body) {
  return new Promise(function (resolve, reject) {
    const urlObj = new URL(urlString);
    if (query) {
      Object.keys(query).forEach(function (key) {
        urlObj.searchParams.set(key, String(query[key]));
      });
    }

    const data = body ? JSON.stringify(body) : null;
    const options = {
      method: method,
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': CONFIG.referer
      }
    };

    if (data) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(options, function (res) {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { raw += chunk; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${urlObj.href} failed: ${res.statusCode} ${raw.slice(0, 300)}`));
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch (error) {
          reject(new Error(`Invalid JSON from ${urlObj.href}: ${error.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, function () {
      req.destroy(new Error(`Request timed out: ${urlObj.href}`));
    });
    if (data) req.write(data);
    req.end();
  });
}

function buildMessage(result) {
  if (result.kind === 'bus-seat') {
    return buildBusSeatMessage(result);
  }

  return [
    'FUJI ROCKオフィシャルツアーに空きが出ました。',
    '',
    `対象: ${result.name}`,
    `出発日: ${result.departureDate}`,
    `人数: 大人${result.adults}名`,
    `残数: ${result.remainingInventory}`,
    '',
    result.url
  ].join('\n');
}

function buildBusSeatMessage(result) {
  const seats = result.selectableBusSeats.map(function (seat) {
    return `- ${seat.name}`;
  });

  return [
    'FUJI ROCKオフィシャルツアーで選択できる便が出ました。',
    '',
    `対象: ${result.name}`,
    `出発日: ${result.departureDate}`,
    `人数: 大人${result.adults}名`,
    `選択可能便数: ${result.selectableBusSeats.length}`,
    '',
    seats.join('\n'),
    '',
    result.url
  ].join('\n');
}

function sendLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_TO;
  const broadcast = String(process.env.LINE_BROADCAST || '').toLowerCase() === 'true';

  if (!token) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is missing.');
  }
  if (!to && !broadcast) {
    throw new Error('LINE_TO is missing. Set LINE_TO or LINE_BROADCAST=true.');
  }

  const endpoint = broadcast ? '/v2/bot/message/broadcast' : '/v2/bot/message/push';
  const payload = broadcast
    ? { messages: [{ type: 'text', text: text }] }
    : { to: to, messages: [{ type: 'text', text: text }] };

  return new Promise(function (resolve, reject) {
    const data = JSON.stringify(payload);
    const req = https.request({
      method: 'POST',
      hostname: 'api.line.me',
      path: endpoint,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, function (res) {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { raw += chunk; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`LINE API failed: ${res.statusCode} ${raw}`));
          return;
        }
        resolve();
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, function () {
      req.destroy(new Error('LINE request timed out.'));
    });
    req.write(data);
    req.end();
  });
}

function readState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {};
  }
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n');
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  lines.forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] === '#') return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'")) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  });
}

function formatStatus(result) {
  const status = result.available ? 'AVAILABLE' : 'sold out';
  if (result.kind === 'bus-seat') {
    return `[${result.checkedAt}] ${status} ${result.name} ${result.departureDate} selectable=${result.remainingInventory}`;
  }
  return `[${result.checkedAt}] ${status} ${result.name} remaining=${result.remainingInventory}`;
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].indexOf(String(value || '').toLowerCase()) !== -1;
}

main().catch(function (error) {
  console.error(error.message);
  process.exitCode = 1;
});
