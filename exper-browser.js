/* Browser-side EXPer adapter for the static V1SU analyzer. */
(function () {
  'use strict';

  const textDecoder = new TextDecoder('utf-8');
  const TDMS_NO_DATA = 0xffffffff;
  const TDMS_PREVIOUS = 0;
  const TDMS_MAX_U64 = 0xffffffffffffffffn;
  const TDMS_SIZES = {
    1: 1, 2: 2, 3: 4, 4: 8, 5: 1, 6: 2, 7: 4, 8: 8,
    9: 4, 10: 8, 0x19: 4, 0x1a: 8, 0x21: 1, 0x44: 16,
    0x08000c: 8, 0x10000d: 16
  };
  const input = document.getElementById('fileInput');
  if (!input) {
    window.EXPerBrowser = { parseTdms, parseWorkbookBuffer, parseWaveformRows, parse001, parsePnrf };
    return;
  }

  const EXPER_ACCEPT = '.csv,.xlsx,.xls,.sqlite,.sqlite3,.db,.db3,.001,.pnrf,.tdms';
  input.multiple = true;
  input.accept = EXPER_ACCEPT;
  input.onchange = null;

  const toolbar = input.closest('.toolbar');
  const panel = document.createElement('div');
  panel.className = 'row exper-import-tools';
  panel.style.marginBottom = '10px';
  panel.innerHTML = [
    '<label>SC mode <select id="experScMode">',
    '<option value="raw">Raw import</option>',
    '<option value="dc">DC short-circuit (20 A)</option>',
    '<option value="ac">AC short-circuit (100 A)</option>',
    '</select></label>',
    '<label><input id="experMergeBuiltIn" type="checkbox" checked> Merge with built-in</label>',
    '<button id="experExtract" class="primary">Extract SC interval</button>',
    '<button id="experRestore">Restore imported</button>',
    '<button id="experExportSqlite" class="good">Export SQLite</button>',
    '<button id="experExportCsv">Export CSV</button>'
  ].join('');
  toolbar.insertAdjacentElement('afterend', panel);

  const controls = {
    mode: panel.querySelector('#experScMode'),
    mergeBuiltIn: panel.querySelector('#experMergeBuiltIn'),
    extract: panel.querySelector('#experExtract'),
    restore: panel.querySelector('#experRestore'),
    exportSqlite: panel.querySelector('#experExportSqlite'),
    exportCsv: panel.querySelector('#experExportCsv')
  };

  const state = window.v1suState;
  const reports = [];
  function status(message, good) {
    if (typeof setStatus === 'function') setStatus(message, Boolean(good));
  }

  function number(value) {
    if (value === null || value === undefined || value === '') return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function normalized(value) {
    return String(value ?? '').trim().toLowerCase().replace(/[\s_\-\/\\()[\].]+/g, '');
  }

  function headerIsTime(value) {
    const text = normalized(value);
    return text.includes('time') || text.includes('timestamp');
  }

  function headerIsVoltage(value) {
    const text = normalized(value);
    return text === 'u' || text === 'uv' || text.startsWith('u2') || text.startsWith('voltage') || text.startsWith('volt');
  }

  function headerIsCurrent(value) {
    const text = normalized(value);
    return text === 'i' || text === 'ia' || text.startsWith('i1') || text.startsWith('current') || text.startsWith('amp');
  }

  function timeScale(header) {
    const text = String(header ?? '').toLowerCase();
    return /time[_ ]?s|time\(s\)|seconds?/.test(text) ? 1000 : 1;
  }

  function cloneSeries(series) {
    return {
      ...series,
      time: series.time.slice(),
      U2: series.U2.slice(),
      I1: series.I1.slice()
    };
  }

  function cloneSeriesMap(seriesMap) {
    return Object.fromEntries(Object.entries(seriesMap || {}).map(([name, series]) => [name, cloneSeries(series)]));
  }

  function uniqueName(target, name, source) {
    let candidate = String(name || source || 'Series');
    if (!target[candidate]) return candidate;
    let index = 2;
    while (target[`${candidate} [${source}:${index}]`]) index += 1;
    return `${candidate} [${source}:${index}]`;
  }

  function addSeries(target, series, source) {
    const baseName = series.name || series.sourceName || source || 'Series';
    const name = uniqueName(target, baseName, source || series.sheet || 'import');
    target[name] = {
      ...cloneSeries(series),
      name,
      sourceName: series.sourceName || baseName,
      sheet: series.sheet || source || 'EXPer'
    };
  }

  function mergeSeriesMaps(base, extra) {
    const result = cloneSeriesMap(base);
    Object.values(extra || {}).forEach(series => addSeries(result, series, series.sheet || 'EXPer'));
    return result;
  }

  function validTriple(rows, rowIndex, column) {
    const row = rows[rowIndex] || [];
    return headerIsTime(row[column]) && headerIsVoltage(row[column + 1]) && headerIsCurrent(row[column + 2]);
  }

  function sourceColumn(rows, headerRow, column) {
    const row = rows[headerRow] || [];
    for (let index = column + 3; index < Math.min(row.length, column + 8); index += 1) {
      const key = normalized(row[index]);
      if (key === 'sourcefile' || key === 'source' || key === 'operationid' || key === 'recordingid') return index;
    }
    return -1;
  }

  function parseMatrixSheet(rows, sheetName, fileName) {
    const found = {};
    const seen = new Set();
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);

    for (let rowIndex = 0; rowIndex < Math.min(rows.length, 40); rowIndex += 1) {
      for (let column = 0; column + 2 < width; column += 1) {
        if (!validTriple(rows, rowIndex, column)) continue;
        const key = `${rowIndex}:${column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let start = rowIndex + 1;
        const units = rows[start] || [];
        if (/^(ms|s|time)$/i.test(String(units[column] ?? '').trim())) start += 1;
        const source = sourceColumn(rows, rowIndex, column);
        const fallbackName = `${fileName}${sheetName ? `:${sheetName}` : ''}${width > 3 ? `:${column + 1}` : ''}`;
        let label = '';
        const time = [];
        const u2 = [];
        const i1 = [];
        let hit = false;
        let blankRows = 0;
        for (let dataRow = start; dataRow < rows.length; dataRow += 1) {
          const row = rows[dataRow] || [];
          const t = number(row[column]);
          const u = number(row[column + 1]);
          const i = number(row[column + 2]);
          if (t === null && u === null && i === null) {
            if (hit) blankRows += 1;
            if (blankRows >= 2) break;
            continue;
          }
          blankRows = 0;
          if (t === null || u === null || i === null) continue;
          hit = true;
          if (!label && source >= 0 && row[source] !== null && row[source] !== undefined && String(row[source]).trim()) {
            label = String(row[source]).trim();
          }
          time.push(t * timeScale(rows[rowIndex][column]));
          u2.push(u);
          i1.push(i);
        }
        if (time.length) {
          const name = label || fallbackName;
          const series = { name, sourceName: name, sheet: sheetName || fileName, time, U2: u2, I1: i1, rows: time.length };
          addSeries(found, series, fileName);
        }
      }
    }
    if (!Object.keys(found).length) {
      let firstDataRow = -1;
      let groupStarts = [];
      for (let rowIndex = 0; rowIndex < Math.min(rows.length, 8); rowIndex += 1) {
        const row = rows[rowIndex] || [];
        const starts = [];
        for (let column = 0; column + 4 < width; column += 1) {
          const time = number(row[column]);
          const voltage = number(row[column + 1]);
          const current = number(row[column + 2]);
          const sourceName = String(row[column + 3] ?? '').trim();
          const empty = String(row[column + 4] ?? '').trim() === '';
          if (time !== null && Math.abs(time) < 1 && voltage !== null && current !== null && sourceName.includes('SUBS26AA') && empty) starts.push(column);
        }
        if (starts.length) {
          firstDataRow = rowIndex;
          groupStarts = starts;
          break;
        }
      }
      for (const column of groupStarts) {
        const firstRow = rows[firstDataRow] || [];
        const name = String(firstRow[column + 3] ?? '').trim() || `${fileName}${sheetName ? `:${sheetName}` : ''}:${column + 1}`;
        const time = [];
        const u2 = [];
        const i1 = [];
        for (let rowIndex = firstDataRow; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex] || [];
          const t = number(row[column]);
          const u = number(row[column + 1]);
          const i = number(row[column + 2]);
          if (t === null || u === null || i === null) continue;
          time.push(t);
          u2.push(u);
          i1.push(i);
        }
        if (time.length) addSeries(found, { name, sourceName: name, sheet: sheetName || fileName, time, U2: u2, I1: i1, rows: time.length }, fileName);
      }
    }
    return found;
  }

  function parseLongWaveform(rows, sheetName, fileName) {
    if (!rows.length) return {};
    const headers = rows[0].map(value => String(value ?? '').trim());
    const normalizedHeaders = headers.map(normalized);
    const operationIndex = normalizedHeaders.findIndex(value => value === 'operationid' || value === 'recordingid' || value === 'sample');
    const timeIndex = normalizedHeaders.findIndex(value => value === 'times' || value === 'timems' || value === 'time');
    const channelIndex = normalizedHeaders.findIndex(value => value === 'channel' || value === 'name');
    const valueIndex = normalizedHeaders.findIndex(value => value === 'value' || value === 'amplitude');
    if (operationIndex < 0 || timeIndex < 0 || channelIndex < 0 || valueIndex < 0) return {};

    const grouped = new Map();
    for (const row of rows.slice(1)) {
      const operation = String(row[operationIndex] ?? '').trim();
      const channel = String(row[channelIndex] ?? '').trim();
      const t = number(row[timeIndex]);
      const value = number(row[valueIndex]);
      if (!operation || !channel || t === null || value === null) continue;
      if (!grouped.has(operation)) grouped.set(operation, new Map());
      const channels = grouped.get(operation);
      if (!channels.has(channel)) channels.set(channel, []);
      channels.get(channel).push([t, value]);
    }

    const result = {};
    for (const [operation, channels] of grouped) {
      const currentName = [...channels.keys()].find(name => /\[a\]|current|^i\d*/i.test(name));
      const voltageName = [...channels.keys()].find(name => /\[v\]|voltage|^u\d*/i.test(name));
      if (!currentName || !voltageName) continue;
      const current = channels.get(currentName);
      const voltage = channels.get(voltageName);
      const length = Math.min(current.length, voltage.length);
      const time = current.slice(0, length).map(item => item[0] * (normalizedHeaders[timeIndex] === 'times' ? 1000 : 1));
      const i1 = current.slice(0, length).map(item => item[1]);
      const u2 = voltage.slice(0, length).map(item => item[1]);
      const name = `${fileName}:${operation}`;
      addSeries(result, { name, sourceName: name, sheet: sheetName || fileName, time, U2: u2, I1: i1, rows: length }, fileName);
    }
    return result;
  }

  function parseNamedChannelRows(rows, sheetName, fileName) {
    if (!rows.length) return {};
    const headers = rows[0].map(value => String(value ?? '').trim());
    const keys = headers.map(normalized);
    const timeIndex = keys.findIndex(key => key === 'times' || key === 'timems' || key === 'time' || key === 'timestamp');
    const voltageCandidates = keys.map((key, index) => ({ key, index })).filter(item => item.key === 'uv' || /^u2v?$/.test(item.key) || /^voltage/.test(item.key) || /^u\d+v?$/.test(item.key));
    const currentCandidates = keys.map((key, index) => ({ key, index })).filter(item => item.key === 'ia' || /^i1a?$/.test(item.key) || /^current/.test(item.key) || /^i\d+a?$/.test(item.key));
    if (timeIndex < 0 || !voltageCandidates.length || !currentCandidates.length) return {};
    const voltageIndex = (voltageCandidates.find(item => item.key.startsWith('u2')) || voltageCandidates.find(item => item.key === 'uv') || voltageCandidates[0]).index;
    const currentIndex = (currentCandidates.find(item => item.key.startsWith('i1')) || currentCandidates.find(item => item.key === 'ia') || currentCandidates[0]).index;
    const timeMultiplier = timeScale(headers[timeIndex]);
    const groupKeys = new Set(['sample', 'sampleno', 'samplename', 'sourcefile', 'source', 'operation', 'operationid', 'recordingid', 'series', 'seriesname', 'testname', 'testid']);
    const groupIndexes = keys.map((key, index) => groupKeys.has(key) && index !== timeIndex && index !== voltageIndex && index !== currentIndex ? index : -1).filter(index => index >= 0);
    const fallbackName = `${fileName}:${headers[currentIndex]}/${headers[voltageIndex]}`;
    const grouped = new Map();
    for (const row of rows.slice(1)) {
      const t = number(row[timeIndex]);
      const u = number(row[voltageIndex]);
      const i = number(row[currentIndex]);
      if (t !== null && u !== null && i !== null) {
        const label = groupIndexes.map(index => String(row[index] ?? '').trim()).filter(Boolean).join(' | ') || fallbackName;
        if (!grouped.has(label)) grouped.set(label, { time: [], U2: [], I1: [] });
        const series = grouped.get(label);
        series.time.push(t * timeMultiplier);
        series.U2.push(u);
        series.I1.push(i);
      }
    }
    const result = {};
    for (const [name, series] of grouped) addSeries(result, { ...series, name, sourceName: name, sheet: sheetName || fileName, rows: series.time.length }, fileName);
    return result;
  }

  function parseWorkbookBuffer(buffer, fileName) {
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: false, raw: true, blankrows: true });
    const result = {};
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: true });
      Object.values(parseWaveformRows(rows, sheetName, fileName)).forEach(series => addSeries(result, series, fileName));
    }
    if (!Object.keys(result).length) throw new Error(`${fileName}: no time/voltage/current waveform columns found`);
    return result;
  }

  function parseWaveformRows(rows, sheetName, fileName) {
    const result = {};
    const named = parseNamedChannelRows(rows, sheetName, fileName);
    const long = parseLongWaveform(rows, sheetName, fileName);
    const wide = parseMatrixSheet(rows, sheetName, fileName);
    Object.values(named).forEach(series => addSeries(result, series, fileName));
    Object.values(long).forEach(series => addSeries(result, series, fileName));
    if (!Object.keys(named).length) Object.values(wide).forEach(series => addSeries(result, series, fileName));
    return result;
  }

  function parse001(buffer, fileName) {
    const headerSize = 384;
    const sampleCount = 100000;
    const intervalMs = 0.02;
    const startMs = -0.4;
    const expectedSize = headerSize + sampleCount * 2 * 4;
    if (buffer.byteLength < expectedSize) throw new Error(`${fileName}: .001 file is shorter than the expected four-channel layout`);
    const view = new DataView(buffer);
    const time = Array.from({ length: sampleCount }, (_, index) => startMs + index * intervalMs);
    const u2 = [];
    const i1 = [];
    for (let index = 0; index < sampleCount; index += 1) {
      i1.push(view.getInt16(headerSize + index * 2, true) * 3.89625);
      u2.push(view.getInt16(headerSize + sampleCount * 2 + index * 2, true) * 1.01);
    }
    const name = `${fileName} (.001 I/U)`;
    return { [name]: { name, sourceName: name, sheet: fileName, time, U2: u2, I1: i1, rows: sampleCount } };
  }

  function pnrfRange(values) {
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return max - min;
  }

  function parsePnrf(buffer, fileName) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const chunks = [];
    for (let offset = Math.min(0x500000, bytes.length - 1); offset < bytes.length - 100;) {
      if (bytes[offset] === 0) {
        offset += 1;
        continue;
      }
      const start = offset;
      while (offset < bytes.length && bytes[offset] !== 0) offset += 1;
      if (offset - start >= 100) {
        const values = [];
        for (let index = start; index + 1 < offset; index += 2) values.push(view.getInt16(index, true));
        if (values.length) chunks.push(values);
      }
      offset += 1;
    }
    let waveformChunks = chunks.filter(values => pnrfRange(values) > 10000);
    if (!waveformChunks.length) waveformChunks = chunks;
    if (!waveformChunks.length) throw new Error(`${fileName}: no waveform chunks found in direct PNRF fallback`);
    const u2 = [];
    const i1 = [];
    for (const chunk of waveformChunks) {
      for (let index = 0; index + 1 < chunk.length; index += 2) {
        u2.push(chunk[index]);
        i1.push(chunk[index + 1]);
      }
    }
    const length = Math.min(u2.length, i1.length);
    const name = `${fileName} (PNRF direct raw ADC)`;
    return {
      [name]: {
        name,
        sourceName: name,
        sheet: fileName,
        time: Array.from({ length }, (_, index) => index * 0.01),
        U2: u2.slice(0, length),
        I1: i1.slice(0, length),
        rows: length
      }
    };
  }

  function tdmsU32(view, offset, little) {
    return view.getUint32(offset, little);
  }

  function tdmsU64(view, offset, little) {
    return Number(view.getBigUint64(offset, little));
  }

  function tdmsString(view, offset, little) {
    const length = tdmsU32(view, offset, little);
    const start = offset + 4;
    return { value: textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + start, length)), next: start + length };
  }

  function tdmsPath(value) {
    const parts = [];
    const matcher = /'((?:''|[^'])*)'/g;
    let match;
    while ((match = matcher.exec(value))) parts.push(match[1].replace(/''/g, "'"));
    return parts;
  }

  function tdmsScalar(view, offset, type, little) {
    const littleEndian = little;
    switch (type) {
      case 1: return { value: view.getInt8(offset), next: offset + 1 };
      case 2: return { value: view.getInt16(offset, littleEndian), next: offset + 2 };
      case 3: return { value: view.getInt32(offset, littleEndian), next: offset + 4 };
      case 4: return { value: Number(view.getBigInt64(offset, littleEndian)), next: offset + 8 };
      case 5: return { value: view.getUint8(offset), next: offset + 1 };
      case 6: return { value: view.getUint16(offset, littleEndian), next: offset + 2 };
      case 7: return { value: view.getUint32(offset, littleEndian), next: offset + 4 };
      case 8: return { value: Number(view.getBigUint64(offset, littleEndian)), next: offset + 8 };
      case 9:
      case 0x19: return { value: view.getFloat32(offset, littleEndian), next: offset + 4 };
      case 10:
      case 0x1a: return { value: view.getFloat64(offset, littleEndian), next: offset + 8 };
      case 0x21: return { value: view.getInt8(offset) !== 0, next: offset + 1 };
      case 0x44: return { value: null, next: offset + 16 };
      default: throw new Error(`Unsupported TDMS scalar type 0x${type.toString(16)}`);
    }
  }

  function tdmsProperty(view, offset, little) {
    const name = tdmsString(view, offset, little);
    const type = tdmsU32(view, name.next, little);
    let value;
    let next = name.next + 4;
    if (type === 0x20) {
      const text = tdmsString(view, next, little);
      value = text.value;
      next = text.next;
    } else {
      const scalar = tdmsScalar(view, next, type, little);
      value = scalar.value;
      next = scalar.next;
    }
    return { name: name.value, value, next };
  }

  function tdmsReadIndex(view, offset, little) {
    const type = tdmsU32(view, offset, little);
    const dimension = tdmsU32(view, offset + 4, little);
    const values = tdmsU64(view, offset + 8, little);
    if (dimension !== 1) throw new Error('TDMS multidimensional channels are not supported');
    if (!TDMS_SIZES[type]) throw new Error(`Unsupported TDMS channel type 0x${type.toString(16)}`);
    return { type, size: TDMS_SIZES[type], values, next: offset + 16 };
  }

  function tdmsReadValue(view, offset, type, little) {
    return tdmsScalar(view, offset, type, little);
  }

  function parseTdms(buffer, fileName) {
    const view = new DataView(buffer);
    const channels = new Map();
    let position = 0;
    let previousOrder = [];
    while (position + 28 <= buffer.byteLength) {
      if (view.getUint8(position) !== 0x54 || view.getUint8(position + 1) !== 0x44 || view.getUint8(position + 2) !== 0x53 || view.getUint8(position + 3) !== 0x6d) break;
      const rawToc = view.getUint32(position + 4, true);
      const little = !(rawToc & (1 << 6));
      const toc = little ? rawToc : view.getUint32(position + 4, false);
      const nextOffset = little ? view.getBigUint64(position + 12, true) : view.getBigUint64(position + 12, false);
      const rawOffset = little ? view.getBigUint64(position + 20, true) : view.getBigUint64(position + 20, false);
      const next = nextOffset === TDMS_MAX_U64 ? buffer.byteLength : position + 28 + Number(nextOffset);
      const dataPosition = position + 28 + Number(rawOffset);
      let order;

      if (toc & (1 << 1)) {
        let cursor = position + 28;
        const objectCount = tdmsU32(view, cursor, little);
        cursor += 4;
        const map = new Map((toc & (1 << 2)) ? [] : previousOrder.map(item => [item.path, { ...item }]));
        order = (toc & (1 << 2)) ? [] : previousOrder.map(item => ({ ...item, hasData: false }));
        for (let index = 0; index < objectCount; index += 1) {
          const pathData = tdmsString(view, cursor, little);
          cursor = pathData.next;
          const path = pathData.value;
          const rawIndexHeader = tdmsU32(view, cursor, little);
          cursor += 4;
          const previous = map.get(path);
          let object;
          if (rawIndexHeader === TDMS_NO_DATA) {
            object = previous ? { ...previous, hasData: false } : { path, hasData: false };
          } else if (rawIndexHeader === TDMS_PREVIOUS) {
            if (!previous) throw new Error(`TDMS object ${path} has no previous data index`);
            object = { ...previous, hasData: true };
          } else {
            const indexData = tdmsReadIndex(view, cursor, little);
            cursor = indexData.next;
            object = { path, ...indexData, hasData: true };
          }
          const propertyCount = tdmsU32(view, cursor, little);
          cursor += 4;
          const properties = previous && previous.properties ? { ...previous.properties } : {};
          for (let propertyIndex = 0; propertyIndex < propertyCount; propertyIndex += 1) {
            const property = tdmsProperty(view, cursor, little);
            cursor = property.next;
            properties[property.name] = property.value;
          }
          object.properties = properties;
          map.set(path, object);
          const existingIndex = order.findIndex(item => item.path === path);
          if (existingIndex >= 0) order[existingIndex] = object;
          else order.push(object);
          if (!channels.has(path)) channels.set(path, { path, properties, values: [] });
          else channels.get(path).properties = properties;
        }
      } else {
        order = previousOrder.map(item => ({ ...item }));
      }

      const dataObjects = order.filter(item => item.hasData && item.size && item.values !== 0);
      const chunkSize = dataObjects.reduce((sum, item) => sum + item.size * item.values, 0);
      if ((toc & (1 << 3)) && chunkSize > 0 && dataPosition < next) {
        const available = next - dataPosition;
        const chunks = Math.max(1, Math.ceil(available / chunkSize));
        for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
          const chunkStart = dataPosition + chunkIndex * chunkSize;
          if (chunkStart >= next) break;
          if (toc & (1 << 5)) {
            const width = dataObjects.reduce((sum, item) => sum + item.size, 0);
            const maxValues = Math.max(...dataObjects.map(item => item.values));
            const offsets = [];
            let relative = 0;
            for (const item of dataObjects) {
              offsets.push(relative);
              relative += item.size;
            }
            for (let valueIndex = 0; valueIndex < maxValues; valueIndex += 1) {
              for (let objectIndex = 0; objectIndex < dataObjects.length; objectIndex += 1) {
                const item = dataObjects[objectIndex];
                if (valueIndex >= item.values) continue;
                const valueOffset = chunkStart + valueIndex * width + offsets[objectIndex];
                if (valueOffset + item.size > next) continue;
                const value = tdmsReadValue(view, valueOffset, item.type, little).value;
                channels.get(item.path).values.push(value);
              }
            }
          } else {
            let cursor = chunkStart;
            for (const item of dataObjects) {
              const channel = channels.get(item.path);
              for (let valueIndex = 0; valueIndex < item.values; valueIndex += 1) {
                if (cursor + item.size > next) break;
                const value = tdmsReadValue(view, cursor, item.type, little).value;
                channel.values.push(value);
                cursor += item.size;
              }
            }
          }
        }
      }
      previousOrder = order;
      if (next <= position) break;
      position = next;
    }

    const usable = [...channels.values()].filter(channel => channel.path.includes("/'") && channel.values.length);
    const grouped = new Map();
    for (const channel of usable) {
      const parts = tdmsPath(channel.path);
      if (parts.length < 2) continue;
      const group = parts[0];
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push({ name: parts[1], values: channel.values, properties: channel.properties });
    }
    const preferred = grouped.get('waveform') || [...grouped.values()][0];
    if (!preferred || !preferred.length) throw new Error(`${fileName}: no numeric TDMS channel data found`);
    const current = preferred.filter(channel => /\[a\]|current|^i\d*/i.test(channel.name));
    const voltage = preferred.filter(channel => /\[v\]|voltage|^u\d*/i.test(channel.name));
    if (!current.length || !voltage.length) throw new Error(`${fileName}: TDMS needs at least one current and one voltage channel`);
    const currentChannel = current.reduce((best, channel) => Math.max(...channel.values.map(Math.abs)) > Math.max(...best.values.map(Math.abs)) ? channel : best);
    const voltageChannel = voltage.find(channel => /^u2/i.test(channel.name)) || voltage[0];
    const length = Math.min(currentChannel.values.length, voltageChannel.values.length);
    const dt = Number(currentChannel.properties.wf_increment || voltageChannel.properties.wf_increment || 1);
    const start = Number(currentChannel.properties.wf_start_offset || voltageChannel.properties.wf_start_offset || 0);
    const name = `${fileName}:${currentChannel.name}/${voltageChannel.name}`;
    return {
      [name]: {
        name,
        sourceName: name,
        sheet: fileName,
        time: Array.from({ length }, (_, index) => (start + index * dt) * 1000),
        U2: voltageChannel.values.slice(0, length),
        I1: currentChannel.values.slice(0, length),
        rows: length
      }
    };
  }

  function extractDc(series) {
    const length = series.time.length;
    if (length < 10) throw new Error(`${series.sourceName}: waveform is too short`);
    const baselineCount = Math.max(10, Math.floor(length * 0.05));
    const sorted = series.I1.slice(0, baselineCount).sort((a, b) => a - b);
    const baseline = sorted[Math.floor(sorted.length / 2)];
    const centered = series.I1.map(value => value - baseline);
    const polarity = Math.abs(Math.max(...centered)) >= Math.abs(Math.min(...centered)) ? 1 : -1;
    const signal = centered.map(value => polarity * value);
    const peak = signal.indexOf(Math.max(...signal));
    const start = signal.findIndex(value => value >= 20);
    if (start < 0 || peak <= start) throw new Error(`${series.sourceName}: no DC pulse above 20 A`);
    const dt = Math.max(1e-9, (series.time[Math.min(length - 1, 1)] - series.time[0]) / 1000);
    const settle = Math.max(3, Math.round(100e-6 / dt));
    let end = -1;
    for (let index = peak; index + settle <= length; index += 1) {
      let valid = true;
      for (let check = index; check < index + settle; check += 1) {
        if (Math.abs(signal[check]) > 20) { valid = false; break; }
      }
      if (valid) { end = index; break; }
    }
    if (end <= peak) throw new Error(`${series.sourceName}: current did not return below 20 A`);
    return sliceSeries(series, start, end, 'DC 20 A');
  }

  function extractAc(series) {
    const over = series.I1.map(value => Math.abs(value) > 100);
    const start = over.findIndex(Boolean);
    if (start < 0) throw new Error(`${series.sourceName}: no AC pulse above 100 A`);
    let peak = start;
    for (let index = start + 1; index < series.I1.length; index += 1) {
      if (Math.abs(series.I1[index]) > Math.abs(series.I1[peak])) peak = index;
    }
    let end = -1;
    for (let index = peak + 1; index < series.I1.length; index += 1) {
      if (Math.abs(series.I1[index]) < 100) { end = index; break; }
    }
    if (end < 0) end = over.reduce((last, value, index) => value ? index : last, peak);
    const dt = series.time.length > 1 ? series.time[1] - series.time[0] : 0;
    end = Math.min(series.time.length - 1, end + Math.max(0, Math.round(0.8 / Math.max(dt, 1e-9))));
    return sliceSeries(series, start, end, 'AC 100 A');
  }

  function sliceSeries(series, start, end, method) {
    const time0 = series.time[start];
    const result = {
      ...cloneSeries(series),
      name: `${series.sourceName} [${method}]`,
      sourceName: `${series.sourceName} [${method}]`,
      time: series.time.slice(start, end + 1).map(value => value - time0),
      U2: series.U2.slice(start, end + 1),
      I1: series.I1.slice(start, end + 1)
    };
    result.rows = result.time.length;
    return result;
  }

  function combineForPage(source) {
    const includeBuiltIn = controls.mergeBuiltIn.checked && state.builtinSeries;
    return includeBuiltIn ? mergeSeriesMaps(state.builtinSeries, source) : cloneSeriesMap(source);
  }

  function applySource(source, label, extraReports) {
    state.experSourceCurrent = cloneSeriesMap(source);
    const combined = combineForPage(source);
    applyImportedSeries(combined, label, []);
    const details = (extraReports || []).filter(Boolean).join(' | ');
    status(`${label} | series: ${Object.keys(combined).length}${details ? ` | ${details}` : ''}`, true);
  }

  function downloadBlob(data, name, type) {
    const blob = new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportCsv() {
    const source = state.experSourceCurrent || {};
    const series = Object.values(source);
    if (!series.length) throw new Error('No imported series to export');
    const rows = [];
    rows.push(series.flatMap(item => [item.sourceName || item.name, '', '', '', '']));
    rows.push(series.flatMap(() => ['time_ms', 'U', 'I', 'source_file', '']));
    rows.push(series.flatMap(() => ['ms', 'V', 'A', '', '']));
    const maximum = Math.max(...series.map(item => item.time.length));
    for (let index = 0; index < maximum; index += 1) {
      rows.push(series.flatMap(item => index < item.time.length
        ? [item.time[index], item.U2[index], item.I1[index], item.sourceName || item.name, '']
        : ['', '', '', '', '']));
    }
    const text = rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    downloadBlob(text, 'EXPer_merged_waveforms.csv', 'text/csv;charset=utf-8');
    status(`Exported ${series.length} imported series to EXPer_merged_waveforms.csv.`, true);
  }

  async function exportSqlite() {
    const source = state.experSourceCurrent || {};
    const series = Object.values(source);
    if (!series.length) throw new Error('No imported series to export');
    const SQL = await ensureSQLite();
    const database = controls.mergeBuiltIn.checked && state.builtinDatabaseBytes ? new SQL.Database(new Uint8Array(state.builtinDatabaseBytes)) : new SQL.Database();
    const manifestExists = dbRows(database, "SELECT name FROM sqlite_master WHERE type='table' AND name='_sheet_manifest'").length > 0;
    if (!manifestExists) database.run('CREATE TABLE _sheet_manifest (sheet_order INTEGER PRIMARY KEY, sheet_name TEXT NOT NULL, csv_file TEXT NOT NULL, sqlite_table TEXT NOT NULL, data_rows INTEGER NOT NULL, column_count INTEGER NOT NULL)');
    const orderRows = dbRows(database, 'SELECT COALESCE(MAX(sheet_order),0) AS value FROM _sheet_manifest');
    const order = Number(orderRows[0]?.value || 0) + 1;
    const tableName = `s${String(order).padStart(2, '0')}_EXPer_import`;
    const columns = series.flatMap((_, index) => [`c${String(index * 5 + 1).padStart(3, '0')}`, `c${String(index * 5 + 2).padStart(3, '0')}`, `c${String(index * 5 + 3).padStart(3, '0')}`, `c${String(index * 5 + 4).padStart(3, '0')}`, `c${String(index * 5 + 5).padStart(3, '0')}`]);
    database.run(`CREATE TABLE "${tableName}" (_row_number INTEGER PRIMARY KEY, ${columns.map(column => `"${column}"`).join(',')})`);
    const maximum = Math.max(...series.map(item => item.time.length));
    const placeholders = Array.from({ length: columns.length + 1 }, () => '?').join(',');
    const statement = database.prepare(`INSERT INTO "${tableName}" VALUES (${placeholders})`);
    for (let rowIndex = 0; rowIndex < maximum; rowIndex += 1) {
      const row = [rowIndex + 1];
      for (const item of series) {
        if (rowIndex < item.time.length) row.push(item.time[rowIndex], item.U2[rowIndex], item.I1[rowIndex], item.sourceName || item.name, null);
        else row.push(null, null, null, null, null);
      }
      statement.run(row);
      statement.reset();
    }
    statement.free();
    database.run('INSERT INTO _sheet_manifest VALUES (?,?,?,?,?,?)', [order, 'EXPer_import', 'EXPer_merged_waveforms.csv', tableName, maximum, columns.length]);
    const bytes = database.export();
    database.close();
    downloadBlob(bytes, 'EXPer_merged_waveforms.sqlite', 'application/vnd.sqlite3');
    status(`Exported ${series.length} imported series into EXPer_merged_waveforms.sqlite.`, true);
  }

  async function readFile(file) {
    const extension = file.name.split('.').pop().toLowerCase();
    const buffer = await file.arrayBuffer();
    if (['sqlite', 'sqlite3', 'db', 'db3'].includes(extension)) {
      const SQL = await ensureSQLite();
      const database = new SQL.Database(new Uint8Array(buffer));
      try {
        return parseSQLiteDatabase(database, file.name, true).series;
      } finally {
        database.close();
      }
    }
    if (extension === '001') return parse001(buffer, file.name);
    if (extension === 'pnrf') return parsePnrf(buffer, file.name);
    if (extension === 'tdms') return parseTdms(buffer, file.name);
    return parseWorkbookBuffer(buffer, file.name);
  }

  async function importFiles(files) {
    if (!files.length) return;
    await ensureLibraries();
    const source = {};
    const importReports = [];
    for (const file of files) {
      try {
        const parsed = await readFile(file);
        Object.values(parsed).forEach(series => addSeries(source, series, file.name));
        importReports.push(`${file.name}: ${Object.keys(parsed).length} series`);
        if (file.name.toLowerCase().endsWith('.pnrf')) importReports.push('PNRF browser fallback uses direct raw ADC chunks; native EXPer Perception conversion remains the calibrated path.');
      } catch (error) {
        importReports.push(`${file.name}: skipped (${error.message})`);
      }
    }
    if (!Object.keys(source).length) throw new Error(importReports.join(' | ') || 'No supported waveform found');
    state.experSourceOriginal = cloneSeriesMap(source);
    state.experSourceCurrent = cloneSeriesMap(source);
    applySource(source, `EXPer import (${files.length} file${files.length === 1 ? '' : 's'})`, importReports);
  }

  function extractCurrent() {
    const source = state.experSourceOriginal || state.experSourceCurrent || {};
    const mode = controls.mode.value;
    if (mode === 'raw') {
      applySource(source, 'EXPer raw import', ['Raw mode selected; no interval extraction applied.']);
      return;
    }
    const extracted = {};
    const failures = [];
    for (const series of Object.values(source)) {
      try {
        const event = mode === 'dc' ? extractDc(series) : extractAc(series);
        addSeries(extracted, event, event.sheet || 'EXPer');
      } catch (error) {
        failures.push(`${series.sourceName}: ${error.message}`);
      }
    }
    if (!Object.keys(extracted).length) throw new Error(failures.join(' | ') || 'No interval could be extracted');
    state.experSourceCurrent = cloneSeriesMap(extracted);
    applySource(extracted, `EXPer ${mode.toUpperCase()} short-circuit intervals`, [`Extracted ${Object.keys(extracted).length} interval series.`, ...failures]);
  }

  input.addEventListener('change', async event => {
    try {
      await importFiles([...event.target.files]);
    } catch (error) {
      status(`EXPer import failed: ${error.message}`);
    }
  });
  controls.extract.addEventListener('click', () => {
    try { extractCurrent(); } catch (error) { status(`SC extraction failed: ${error.message}`); }
  });
  controls.restore.addEventListener('click', () => {
    if (!state.experSourceOriginal) return status('No EXPer import to restore.');
    applySource(state.experSourceOriginal, 'EXPer imported raw data', ['Restored the imported, untrimmed series.']);
  });
  controls.exportCsv.addEventListener('click', () => {
    try { exportCsv(); } catch (error) { status(`CSV export failed: ${error.message}`); }
  });
  controls.exportSqlite.addEventListener('click', async () => {
    try { await exportSqlite(); } catch (error) { status(`SQLite export failed: ${error.message}`); }
  });
  status('EXPer browser adapter ready. Select CSV, Excel, SQLite, .001, PNRF, or TDMS files.', true);
})();
