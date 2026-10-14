/* Browser-side electrical-life TDMS workflow for the DataAnalyzer subpage. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const els = {
    loadBundled: $('loadBundled'), dataImportInput: $('dataImportInput'), tdmsInput: $('tdmsInput'), mergeBundled: $('mergeBundled'),
    clearImported: $('clearImported'), exportCsv: $('exportCsv'), exportSqlite: $('exportSqlite'),
    status: $('status'), metrics: $('metrics'), trendPlot: $('trendPlot'), waveformPlot: $('waveformPlot'),
    recordInfo: $('recordInfo'),
    waveformRecordFilter: $('waveformRecordFilter'),
    waveformRecordSelectVisible: $('waveformRecordSelectVisible'), waveformRecordClear: $('waveformRecordClear'),
    waveformRecordSummary: $('waveformRecordSummary'), waveformRecordList: $('waveformRecordList'),
  };
  const state = {
    db: null, bundled: [], fileImported: [], imported: [], active: [], skipped: [], sql: null,
    selectedWaveformRecords: new Set(), waveformRecordSelectionInitialized: false
  };
  const sampleMetadataOverrides = new Map([
    ['SMPL26AC9034', { parameter: 'D63 1P 250V', description: 'SPEC26AA5492 | SUBS26AA2542' }],
    ['SMPL26AC9035', { parameter: 'D63 1P 250V', description: 'SPEC26AA5492 | SUBS26AA2542' }],
    ['SMPL26AC9036', { parameter: 'D63 1P 250V', description: 'SPEC26AA5492 | SUBS26AA2542' }],
    ['SMPL26AH0312', { description: 'SPEC26AB4403 | SUBS26AA6032' }],
    ['SMPL26AH0313', { description: 'SPEC26AB4403 | SUBS26AA6032' }],
    ['SMPL26AH0314', { description: 'SPEC26AB4403 | SUBS26AA6032' }]
  ]);

  function status(message, error = false) {
    els.status.textContent = message;
    els.status.classList.toggle('error', error);
  }

  function createTArcLabel() {
    const label = document.createElement('span');
    label.append('t');
    const subscript = document.createElement('sub');
    subscript.textContent = 'arc';
    label.appendChild(subscript);
    return label;
  }

  function number(value) {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function experimentParameterName(source) {
    const configuredParameter = sampleMetadataOverrides.get(source.sample)?.parameter;
    if (configuredParameter) return configuredParameter;
    const ratedCurrent = number(source.rated_current_a);
    const poleCount = number(source.pole_count);
    const nominalVoltage = number(source.nominal_voltage_v);
    const formatValue = value => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
    if (ratedCurrent > 0 && poleCount > 0 && nominalVoltage > 0) {
      const description = `${source.test_name || ''} ${source.test_id || ''}`;
      const curve = source.curveType || source.curve || description.match(/\b([A-D])\s*(?=\d)/i)?.[1] || 'D';
      return `${String(curve).toUpperCase()}${formatValue(ratedCurrent)} ${formatValue(poleCount)}P ${formatValue(nominalVoltage)}V`;
    }
    return String(source.test_name || source.test_id || source.source_file || 'Experiment').replace(/_/g, ' ').trim();
  }

  function alignWaveform(timeValues, voltageValues, currentValues) {
    const length = Math.min(timeValues?.length || 0, voltageValues?.length || 0, currentValues?.length || 0);
    const points = [];
    for (let index = 0; index < length; index += 1) {
      const time = number(timeValues[index]);
      const voltage = number(voltageValues[index]);
      const current = number(currentValues[index]);
      if (time !== null && voltage !== null && current !== null) points.push({ time, voltage, current });
    }
    if (!points.length) return null;

    const first = points[0];
    return {
      time: points.map(point => point.time - first.time),
      voltage: points.map(point => point.voltage - first.voltage),
      currentDrop: points.map(point => Math.max(0, Math.abs(first.current) - Math.abs(point.current))),
      originalCurrent: points.map(point => Math.abs(point.current))
    };
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return NaN;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function query(db, sql, params = []) {
    const statement = db.prepare(sql);
    try {
      if (params.length) statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  function sqlIdentifier(value) { return `"${String(value).replace(/"/g, '""')}"`; }

  async function ensureSql() {
    if (state.sql) return state.sql;
    if (typeof initSqlJs !== 'function') throw new Error('SQLite WASM library is not available.');
    state.sql = await initSqlJs({ locateFile: file => `libs/${file}` });
    return state.sql;
  }

  function recordKey(row) {
    return `${row.test_id}|${row.sample}|${row.operation}|${row.source_file}`;
  }

  function readElectricalLifeDatabase(db) {
    const tables = new Set(query(db, "SELECT name FROM sqlite_master WHERE type='table'").map(row => String(row.name).toLowerCase()));
    if (!tables.has('electrical_life_operations') || !tables.has('electrical_life_waveform')) {
      throw new Error('SQLite file must contain electrical_life_operations and electrical_life_waveform tables.');
    }
    const operations = query(db, 'SELECT * FROM electrical_life_operations ORDER BY test_id, sample, operation, source_file');
    const waveformRows = query(db, 'SELECT * FROM electrical_life_waveform ORDER BY test_id, sample, operation, source_file, time_s');
    const byKey = new Map();
    for (const operation of operations) {
      const record = { ...operation, time_s: [], current_a: [], voltage_v: [] };
      byKey.set(recordKey(record), record);
    }
    for (const row of waveformRows) {
      const record = byKey.get(recordKey(row));
      if (!record) continue;
      record.time_s.push(Number(row.time_s));
      record.current_a.push(Number(row.current_a));
      record.voltage_v.push(Number(row.voltage_v));
    }
    const skipped = tables.has('electrical_life_skipped')
      ? query(db, 'SELECT * FROM electrical_life_skipped ORDER BY test_id, sample, source_file')
      : [];
    const records = [...byKey.values()];
    for (const record of records) {
      record.current_channel = record.current_channel || 'I1';
      record.voltage_channel = record.voltage_channel || 'U2';
    }
    return { records, skipped };
  }

  function readBundledDatabase(db) {
    const loaded = readElectricalLifeDatabase(db);
    state.bundled = loaded.records;
    state.skipped = loaded.skipped;
  }

  async function loadBundled() {
    try {
      status('Loading dedicated electrical-life SQLite database...');
      const response = await fetch('data/ELECTRICAL_LIFE_DATABASE.sqlite', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const SQL = await ensureSql();
      if (state.db) state.db.close();
      state.db = new SQL.Database(new Uint8Array(await response.arrayBuffer()));
      readBundledDatabase(state.db);
      refreshActive();
      status(`Loaded ${state.bundled.length} bundled electrical-life records and ${state.skipped.length} skipped files.`, false);
    } catch (error) {
      status(`Bundled database failed: ${error.message}. Import SQLite, Excel, CSV, or TDMS files, or serve this page over HTTP(S).`, true);
    }
  }

  const importColumnAliases = new Map([
    ['testid', 'test_id'], ['testname', 'test_name'], ['sample', 'sample'], ['sampleid', 'sample'], ['sampleno', 'sample'], ['samplenumber', 'sample'],
    ['operation', 'operation'], ['operationno', 'operation'], ['operationnumber', 'operation'], ['op', 'operation'],
    ['sourcefile', 'source_file'], ['filename', 'source_file'], ['file', 'source_file'], ['recordingtype', 'recording_type'], ['currentchannel', 'current_channel'], ['i1channel', 'current_channel'], ['voltagechannel', 'voltage_channel'], ['u2channel', 'voltage_channel'],
    ['dts', 'dt_s'], ['sampleintervals', 'dt_s'], ['samplingintervals', 'dt_s'], ['nsamples', 'n_samples'], ['samplecount', 'n_samples'],
    ['times', 'time_s'], ['time', 'time_s'], ['timeinseconds', 'time_s'],
    ['currenta', 'current_a'], ['current', 'current_a'], ['i1', 'current_a'], ['i1a', 'current_a'],
    ['voltagev', 'voltage_v'], ['voltage', 'voltage_v'], ['u2', 'voltage_v'], ['u2v', 'voltage_v'],
    ['windowms', 'window_ms'], ['arcwindowms', 'window_ms'], ['tarcms', 'window_ms'], ['initialcurrenta', 'initial_current_a'], ['initialcurrent', 'initial_current_a'], ['initiala', 'initial_current_a'],
    ['finalcurrenta', 'final_current_a'], ['finalcurrent', 'final_current_a'], ['finala', 'final_current_a'], ['peakcurrenta', 'peak_current_a'],
    ['peakvoltagev', 'peak_voltage_v'], ['peakvoltage', 'peak_voltage_v'], ['peakv', 'peak_voltage_v'], ['plateauvoltagev', 'plateau_voltage_v'],
    ['i2ta2s', 'i2t_a2s'], ['i2t', 'i2t_a2s'], ['finalzero', 'final_zero'],
    ['ratedcurrenta', 'rated_current_a'], ['polecount', 'pole_count'], ['nominalvoltagev', 'nominal_voltage_v'], ['curve', 'curve']
  ]);
  const importMetadataFields = [
    'test_name', 'recording_type', 'dt_s', 'n_samples', 'window_ms', 'initial_current_a', 'final_current_a', 'peak_current_a',
    'peak_voltage_v', 'plateau_voltage_v', 'i2t_a2s', 'final_zero', 'rated_current_a', 'pole_count', 'nominal_voltage_v', 'curve', 'current_channel', 'voltage_channel'
  ];

  function normalizeImportColumn(value) {
    return String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function importedNumber(value) {
    if (value == null || String(value).trim() === '') return null;
    const result = Number(String(value).trim().replace(/,/g, ''));
    return Number.isFinite(result) ? result : null;
  }

  function importedBoolean(value) {
    if (value == null || String(value).trim() === '') return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const normalized = String(value).trim().toLowerCase();
    if (['true', 'yes', 'y'].includes(normalized)) return 1;
    if (['false', 'no', 'n'].includes(normalized)) return 0;
    const numeric = importedNumber(value);
    return numeric === null ? null : numeric ? 1 : 0;
  }

  function parseTabularRows(rows, fileName) {
    const metricFields = ['window_ms', 'initial_current_a', 'final_current_a', 'peak_voltage_v', 'i2t_a2s', 'final_zero'];
    const waveformRows = [];
    const operationRows = [];
    const headerLimit = Math.min(rows.length, 30);
    for (let headerIndex = 0; headerIndex < headerLimit; headerIndex += 1) {
      const header = rows[headerIndex] || [];
      const columns = header.map((value, index) => ({ index, field: importColumnAliases.get(normalizeImportColumn(value)) })).filter(column => column.field);
      const fields = new Set(columns.map(column => column.field));
      const hasWaveform = fields.has('time_s') && fields.has('current_a') && fields.has('voltage_v');
      const hasMetrics = metricFields.some(field => fields.has(field));
      if (!fields.has('sample') || !fields.has('operation') || (!hasWaveform && !hasMetrics)) continue;

      for (const sourceRow of rows.slice(headerIndex + 1)) {
        const values = {};
        for (const column of columns) values[column.field] = sourceRow[column.index];
        const sample = String(values.sample ?? '').trim();
        const operation = importedNumber(values.operation);
        if (!sample || operation === null) continue;
        const record = {
          ...values,
          test_id: String(values.test_id ?? 'IMPORTED_FILE').trim() || 'IMPORTED_FILE',
          sample,
          operation,
          source_file: String(values.source_file ?? '').trim(),
          _fileName: fileName
        };
        if (hasWaveform) {
          const time = importedNumber(values.time_s);
          const current = importedNumber(values.current_a);
          const voltage = importedNumber(values.voltage_v);
          if (time !== null && current !== null && voltage !== null) {
            waveformRows.push({ ...record, _time: time, _current: current, _voltage: voltage });
          }
        } else if (hasMetrics) {
          operationRows.push(record);
        }
      }
      return { operationRows, waveformRows };
    }
    return { operationRows, waveformRows };
  }

  function buildImportedRecords(operationRows, waveformRows) {
    const byKey = new Map();
    function getRecord(row) {
      const testId = String(row.test_id || 'IMPORTED_FILE');
      const sample = String(row.sample || '').trim();
      const operation = importedNumber(row.operation);
      const sourceFile = String(row.source_file || '').trim();
      const key = JSON.stringify([testId, sample, operation, sourceFile]);
      let record = byKey.get(key);
      if (!record) {
        record = { test_id: testId, sample, operation, source_file: sourceFile || row._fileName || '', time_s: [], current_a: [], voltage_v: [] };
        byKey.set(key, record);
      }
      if (!record.source_file && row._fileName) record.source_file = row._fileName;
      for (const field of importMetadataFields) {
        const rawValue = row[field];
        if (rawValue == null || String(rawValue).trim() === '') continue;
        const value = field === 'final_zero' ? importedBoolean(rawValue) : importedNumber(rawValue) ?? String(rawValue).trim();
        if (value !== null && (record[field] == null || record[field] === '')) record[field] = value;
      }
      return record;
    }

    for (const row of operationRows) getRecord(row);
    for (const row of waveformRows) {
      const record = getRecord(row);
      record.time_s.push(row._time);
      record.current_a.push(row._current);
      record.voltage_v.push(row._voltage);
    }

    return [...byKey.values()].map(record => {
      const points = record.time_s.map((time, index) => ({ time, current: record.current_a[index], voltage: record.voltage_v[index] })).sort((left, right) => left.time - right.time);
      record.time_s = points.map(point => point.time);
      record.current_a = points.map(point => point.current);
      record.voltage_v = points.map(point => point.voltage);
      const intervals = record.time_s.slice(1).map((time, index) => time - record.time_s[index]).filter(interval => interval > 0);
      const initialCurrent = importedNumber(record.initial_current_a) ?? Math.abs(record.current_a[0] || 0);
      const finalCurrent = importedNumber(record.final_current_a) ?? Math.abs(record.current_a.at(-1) || 0);
      let i2t = 0;
      for (let index = 1; index < record.time_s.length; index += 1) {
        const interval = record.time_s[index] - record.time_s[index - 1];
        i2t += 0.5 * (record.current_a[index - 1] ** 2 + record.current_a[index] ** 2) * interval;
      }
      record.dt_s = importedNumber(record.dt_s) ?? (median(intervals) || 0);
      record.n_samples = importedNumber(record.n_samples) ?? record.time_s.length;
      record.window_ms = importedNumber(record.window_ms) ?? (record.time_s.length ? (record.time_s.at(-1) - record.time_s[0]) * 1000 : 0);
      record.initial_current_a = initialCurrent;
      record.final_current_a = finalCurrent;
      record.peak_voltage_v = importedNumber(record.peak_voltage_v) ?? (record.voltage_v.length ? Math.max(...record.voltage_v.map(Math.abs)) : 0);
      record.i2t_a2s = importedNumber(record.i2t_a2s) ?? i2t;
      record.final_zero = importedBoolean(record.final_zero) ?? (initialCurrent > 0 && finalCurrent < initialCurrent * 0.1 ? 1 : 0);
      record.current_channel = record.current_channel || 'I1';
      record.voltage_channel = record.voltage_channel || 'U2';
      return record;
    });
  }

  async function readTabularFile(file) {
    if (typeof XLSX === 'undefined') throw new Error('Excel/CSV parser library is unavailable.');
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false, raw: true, blankrows: true });
    const operationRows = [];
    const waveformRows = [];
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false });
      const parsed = parseTabularRows(rows, file.name);
      operationRows.push(...parsed.operationRows);
      waveformRows.push(...parsed.waveformRows);
    }
    const records = buildImportedRecords(operationRows, waveformRows);
    if (!records.length) throw new Error(`${file.name}: no electrical-life rows found. Include sample and operation columns, plus waveform or operation metrics.`);
    return records;
  }

  async function importDataFiles(files) {
    if (!files.length) return;
    status(`Importing ${files.length} data file${files.length === 1 ? '' : 's'}...`);
    const importedRecords = [];
    let skippedCount = 0;
    for (const file of files) {
      const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
      if (['.sqlite', '.sqlite3', '.db', '.db3'].includes(extension)) {
        const SQL = await ensureSql();
        const database = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
        try {
          const loaded = readElectricalLifeDatabase(database);
          if (!loaded.records.length) throw new Error(`${file.name}: no electrical-life operation records found.`);
          importedRecords.push(...loaded.records);
          skippedCount += loaded.skipped.length;
        } finally {
          database.close();
        }
      } else if (['.xlsx', '.xls', '.csv'].includes(extension)) {
        importedRecords.push(...await readTabularFile(file));
      } else {
        throw new Error(`${file.name}: unsupported file type. Choose SQLite, Excel, or CSV.`);
      }
    }
    if (!importedRecords.length) throw new Error('No electrical-life records were found in the selected files.');
    state.fileImported = importedRecords;
    refreshActive();
    const recordLabel = importedRecords.length === 1 ? 'record' : 'records';
    const fileLabel = files.length === 1 ? 'file' : 'files';
    status(`Imported ${importedRecords.length} ${recordLabel} from ${files.length} ${fileLabel}${skippedCount ? `; ${skippedCount} skipped files in SQLite` : ''}.`);
  }

  function movingAverage(values, width) {
    const result = [];
    for (let index = 0; index < values.length - width + 1; index += 1) {
      let sum = 0;
      for (let cursor = index; cursor < index + width; cursor += 1) sum += values[cursor];
      result.push(sum / width);
    }
    return result;
  }

  function operationNumber(fileName) {
    const match = String(fileName).match(/_(\d+)_\d{14}_(?:interval_|quantity_)?data\.tdms$/i);
    if (!match) throw new Error('operation number not found in filename');
    return Number(match[1]);
  }

  function sampleId(file) {
    const path = file.webkitRelativePath || file.name;
    const match = path.match(/(SMPL[A-Z0-9]+)/i);
    return match ? match[1] : 'IMPORTED_SAMPLE';
  }

  function extractTdmsSeries(series, file) {
    const timeMs = series.time.map(Number);
    const current = series.I1.map(Number);
    const voltage = series.U2.map(Number);
    const dtMs = median(timeMs.slice(1).map((value, index) => value - timeMs[index]).filter(value => value > 0));
    if (!Number.isFinite(dtMs) || dtMs <= 0) throw new Error('invalid wf_increment');
    const invalidCount = Math.round(1000 / dtMs);
    if (current.length <= invalidCount + 20) throw new Error('recording is too short after the first 1 s');
    const validTime = timeMs.slice(invalidCount);
    const validCurrent = current.slice(invalidCount);
    const validVoltage = voltage.slice(invalidCount);
    const initialCount = Math.max(1, Math.min(validCurrent.length, Math.round(50 / dtMs)));
    const initialCurrent = validCurrent.slice(0, initialCount).reduce((a, b) => a + b, 0) / initialCount;
    const finalCurrent = validCurrent.slice(-initialCount).reduce((a, b) => a + b, 0) / initialCount;
    if (!(initialCurrent > 10 && Math.abs(finalCurrent) < initialCurrent * 0.5)) throw new Error('no rated-current to low-current transition');
    const initialVoltage = validVoltage.slice(0, initialCount).reduce((a, b) => a + b, 0) / initialCount;
    const finalVoltage = validVoltage.slice(-initialCount).reduce((a, b) => a + b, 0) / initialCount;
    if (!(Math.abs(initialVoltage) < 50 && Math.max(...validVoltage) > 200 && finalVoltage > 200)) throw new Error('no near-zero to supply-scale voltage transition');
    const smoothWidth = Math.max(1, Math.round(0.5 / dtMs));
    const smooth = movingAverage(validCurrent, smoothWidth);
    const dropIndex = smooth.findIndex(value => value < initialCurrent * 0.95);
    if (dropIndex < 0) throw new Error('current drop not detected');
    const zeroIndex = smooth.findIndex(value => Math.abs(value) < initialCurrent * 0.05);
    const finalZero = Math.abs(finalCurrent) < initialCurrent * 0.10;
    const preCount = Math.max(1, Math.round(5 / dtMs));
    const postZeroCount = Math.max(1, Math.round(5 / dtMs));
    const postNonzeroCount = Math.max(1, Math.round(20 / dtMs));
    const start = Math.max(0, dropIndex - preCount);
    const end = Math.min(validCurrent.length - 1, finalZero && zeroIndex >= 0 ? zeroIndex + postZeroCount : dropIndex + postNonzeroCount);
    const eventTime = validTime.slice(start, end + 1).map(value => (value - validTime[start]) / 1000);
    const eventCurrent = validCurrent.slice(start, end + 1);
    const rawVoltage = validVoltage.slice(start, end + 1);
    const eventVoltage = rawVoltage.map(value => value - rawVoltage[0]);
    const finalCount = Math.max(1, Math.min(eventCurrent.length, Math.round(1 / dtMs)));
    const iFinal = eventCurrent.slice(-finalCount).reduce((a, b) => a + b, 0) / finalCount;
    const vFinal = eventVoltage.slice(-finalCount).reduce((a, b) => a + b, 0) / finalCount;
    const peakVoltage = Math.max(...eventVoltage);
    const currentStart = Math.round(5 / dtMs);
    let i2t = 0;
    for (let index = currentStart + 1; index < eventCurrent.length; index += 1) {
      i2t += 0.5 * (eventCurrent[index - 1] ** 2 + eventCurrent[index] ** 2) * (eventTime[index] - eventTime[index - 1]);
    }
    const fileName = file.name;
    return {
      test_id: 'IMPORTED_TDMS', test_name: 'Imported TDMS electrical life', pole_count: null,
      rated_current_a: 63, nominal_voltage_v: peakVoltage, sample: sampleId(file),
      operation: operationNumber(fileName), recording_type: /_quantity_/.test(fileName) ? 'quantity' : /_interval_/.test(fileName) ? 'interval' : 'data',
      source_file: fileName, dt_s: dtMs / 1000, current_channel: series.sourceName || 'current', voltage_channel: 'voltage',
      n_samples: eventTime.length, window_ms: eventTime[eventTime.length - 1] * 1000, drop_time_ms: 5,
      zero_time_ms: finalZero && zeroIndex >= 0 ? eventTime[eventTime.length - 1] * 1000 - 5 : null,
      initial_current_a: eventCurrent.slice(0, finalCount).reduce((a, b) => a + b, 0) / finalCount,
      final_current_a: iFinal, peak_current_a: Math.max(...eventCurrent.map(Math.abs)), peak_voltage_v: peakVoltage,
      plateau_voltage_v: vFinal, i2t_a2s: i2t, final_zero: finalZero ? 1 : 0,
      time_s: eventTime, current_a: eventCurrent, voltage_v: eventVoltage
    };
  }

  async function importTdms(files) {
    if (!window.EXPerBrowser || typeof window.EXPerBrowser.parseTdms !== 'function') throw new Error('EXPer TDMS parser is unavailable.');
    const imported = [];
    const skipped = [];
    for (const file of files) {
      try {
        const parsed = window.EXPerBrowser.parseTdms(await file.arrayBuffer(), file.name);
        const series = Object.values(parsed)[0];
        imported.push(extractTdmsSeries(series, file));
      } catch (error) {
        skipped.push({ test_id: 'IMPORTED_TDMS', test_name: 'Imported TDMS electrical life', sample: sampleId(file), source_file: file.name, reason: error.message });
      }
    }
    state.imported = imported;
    state.skipped = [...state.skipped.filter(row => row.test_id !== 'IMPORTED_TDMS'), ...skipped];
    refreshActive();
    status(`Extracted ${imported.length}/${files.length} TDMS records; skipped ${skipped.length}.`, imported.length > 0);
  }

  function refreshActive() {
    const imported = [...state.fileImported, ...state.imported];
    const source = els.mergeBundled.checked ? [...state.bundled, ...imported] : imported;
    state.active = source;
    refreshWaveformSelection();
    renderComparison();
  }

  function samples() { return [...new Set(state.active.map(row => row.sample))].sort(); }
  function recordsForSample(sample) { return state.active.filter(row => row.sample === sample).sort((a, b) => a.operation - b.operation); }
  function waveformRecordKey(record) { return `${record.test_id}|${record.sample}|${record.operation}|${record.source_file}`; }

  function sampleDescription(record) {
    const configuredDescription = sampleMetadataOverrides.get(record.sample)?.description;
    if (configuredDescription) return `${record.sample} | ${configuredDescription}`;
    return `${record.sample} | ${record.recording_type || 'record'} | ${record.source_file || ''}`;
  }

  function sampleParameterLabels() {
    const ordinals = new Map();
    const labels = new Map();
    for (const sample of samples()) {
      const parameter = experimentParameterName(recordsForSample(sample)[0] || {});
      const key = parameter.toLowerCase();
      const sampleNumber = (ordinals.get(key) || 0) + 1;
      ordinals.set(key, sampleNumber);
      labels.set(sample, `${parameter} ${String(sampleNumber).padStart(2, '0')}#`);
    }
    return labels;
  }

  function updateWaveformRecordSummary() {
    const visibleCount = els.waveformRecordList.querySelectorAll('input[data-record-key]').length;
    els.waveformRecordSummary.textContent = `${state.selectedWaveformRecords.size} selected / ${state.active.length} records (${visibleCount} shown)`;
    els.waveformRecordSelectVisible.disabled = !visibleCount;
    els.waveformRecordClear.disabled = !state.selectedWaveformRecords.size;
  }

  function renderWaveformRecordSelector() {
    const parameterLabels = sampleParameterLabels();
    const terms = els.waveformRecordFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const records = state.active.slice().sort((left, right) => left.sample.localeCompare(right.sample) || left.operation - right.operation || String(left.source_file).localeCompare(String(right.source_file)));
    const visibleRecords = records.filter(record => {
      const parameter = parameterLabels.get(record.sample) || experimentParameterName(record);
      const description = sampleDescription(record);
      const searchable = `${parameter} ${description} ${record.test_name || ''} ${record.test_id || ''} operation ${record.operation} ${record.recording_type || ''} ${record.source_file || ''}`.toLowerCase();
      return terms.every(term => searchable.includes(term));
    });

    els.waveformRecordList.replaceChildren();
    for (const record of visibleRecords) {
      const key = waveformRecordKey(record);
      const item = document.createElement('label');
      item.className = 'waveform-record-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.recordKey = key;
      checkbox.checked = state.selectedWaveformRecords.has(key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selectedWaveformRecords.add(key);
        else state.selectedWaveformRecords.delete(key);
        updateWaveformRecordSummary();
        renderSelectedWaveform();
      });
      const name = document.createElement('span');
      name.className = 'waveform-record-name';
      name.textContent = `${parameterLabels.get(record.sample) || experimentParameterName(record)} | operation ${record.operation}`;
      const detail = document.createElement('span');
      detail.className = 'waveform-record-meta';
      detail.textContent = sampleDescription(record);
      item.append(checkbox, name, detail);
      els.waveformRecordList.appendChild(item);
    }
    if (!visibleRecords.length) {
      const empty = document.createElement('div');
      empty.className = 'small';
      empty.textContent = records.length ? 'No records match this filter.' : 'No interruption records available.';
      els.waveformRecordList.appendChild(empty);
    }
    updateWaveformRecordSummary();
  }

  function refreshWaveformSelection() {
    const availableKeys = new Set(state.active.map(waveformRecordKey));
    state.selectedWaveformRecords = new Set([...state.selectedWaveformRecords].filter(key => availableKeys.has(key)));
    if (!state.active.length) {
      state.waveformRecordSelectionInitialized = false;
    } else if (!state.waveformRecordSelectionInitialized) {
      const record = state.active.slice().sort((left, right) => left.sample.localeCompare(right.sample) || left.operation - right.operation || String(left.source_file).localeCompare(String(right.source_file)))[0];
      if (record) state.selectedWaveformRecords.add(waveformRecordKey(record));
      state.waveformRecordSelectionInitialized = true;
    }
    renderWaveformRecordSelector();
    renderSelectedWaveform();
  }

  function renderMetrics(records) {
    const zero = records.filter(row => row.final_zero).length;
    const maxI2t = records.reduce((best, row) => Math.max(best, Number(row.i2t_a2s)), 0);
    const maxArc = records.reduce((best, row) => Math.max(best, Number(row.window_ms)), 0);
    els.metrics.innerHTML = [
      ['Sampled records', records.length], ['Near-zero return', records.length ? `${(zero * 100 / records.length).toFixed(1)}%` : '-'],
      ['Max t<sub>arc</sub>', `${maxArc.toFixed(2)} ms`], ['Max I²t', `${maxI2t.toFixed(2)} A²·s`]
    ].map(item => `<div class="metric"><b>${item[1]}</b><span>${item[0]}</span></div>`).join('');
  }

  function renderComparison() {
    const recordGroups = samples().map(sample => ({ sample, records: recordsForSample(sample) }));
    const parameterLabels = sampleParameterLabels();
    const traces = [];
    renderMetrics(state.active);
    for (const group of recordGroups) {
      const sampleLabel = parameterLabels.get(group.sample);
      traces.push({ x: group.records.map(row => row.operation), y: group.records.map(row => row.i2t_a2s), name: `${sampleLabel} I²t`, mode: 'lines+markers', type: 'scatter', yaxis: 'y1' });
      traces.push({ x: group.records.map(row => row.operation), y: group.records.map(row => row.window_ms), name: `${sampleLabel} t<sub>arc</sub>`, mode: 'lines+markers', type: 'scatter', yaxis: 'y2' });
    }
    Plotly.react(els.trendPlot, traces, { margin: { l: 60, r: 70, t: 20, b: 210 }, paper_bgcolor: '#fff', plot_bgcolor: '#fff', hovermode: 'x unified', xaxis: { title: 'Sampled operation count', gridcolor: '#e7ffd9' }, yaxis: { title: 'I²t (A²·s)', gridcolor: '#e7ffd9' }, yaxis2: { title: 't<sub>arc</sub> (ms)', overlaying: 'y', side: 'right' }, legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.45, yanchor: 'top' } }, { responsive: true, displaylogo: false });
  }

  function renderSelectedWaveform() {
    const selectedRecords = state.active.filter(record => state.selectedWaveformRecords.has(waveformRecordKey(record))).sort((left, right) => left.sample.localeCompare(right.sample) || left.operation - right.operation || String(left.source_file).localeCompare(String(right.source_file)));
    const traces = [];
    const summaries = [];
    const parameterLabels = sampleParameterLabels();
    const colors = ['#e63946', '#1982c4', '#3d8b40', '#8e5ea2', '#d97925', '#008c95', '#b8435d', '#6379b5', '#8a7a20', '#397c78'];
    selectedRecords.forEach((record, index) => {
      const recordLabel = `${parameterLabels.get(record.sample) || experimentParameterName(record)} | operation ${record.operation}`;
      const alignedRecord = alignWaveform(record.time_s.map(time => time * 1000), record.voltage_v, record.current_a);
      if (alignedRecord) {
        const color = colors[index % colors.length];
        traces.push(
          { x: alignedRecord.time, y: alignedRecord.voltage, name: `${recordLabel} U2`, mode: 'lines', line: { color, width: 2 }, yaxis: 'y', hovertemplate: `${recordLabel}<br>t=%{x:.6f} ms<br>U2 change=%{y:.6f} V<extra></extra>` },
          { x: alignedRecord.time, y: alignedRecord.currentDrop, name: `${recordLabel} I1`, mode: 'lines', line: { color, width: 2, dash: 'dash' }, yaxis: 'y2', customdata: alignedRecord.originalCurrent, hovertemplate: `${recordLabel}<br>t=%{x:.6f} ms<br>Current drop=%{y:.6f} A<br>Current=%{customdata:.6f} A<extra></extra>` }
        );
      }
    });
    if (selectedRecords.length === 1) {
      const record = selectedRecords[0];
      const recordSummary = document.createDocumentFragment();
      recordSummary.append(`${parameterLabels.get(record.sample) || experimentParameterName(record)} | ${sampleDescription(record)} | operation ${record.operation} | ${record.current_channel} / ${record.voltage_channel} | `);
      recordSummary.appendChild(createTArcLabel());
      recordSummary.append(` ${record.window_ms.toFixed(2)} ms | I²t ${Number(record.i2t_a2s).toFixed(3)} A²·s`);
      summaries.push(recordSummary);
    } else if (selectedRecords.length > 1) {
      summaries.push(`${selectedRecords.length} interruption records shown`);
    } else if (state.active.length) {
      summaries.push('No interruption records selected');
    }
    els.recordInfo.replaceChildren();
    if (!summaries.length) {
      els.recordInfo.textContent = 'Select one or more interruption records.';
    } else {
      summaries.forEach((summary, index) => {
        if (index) els.recordInfo.append(' | ');
        els.recordInfo.append(summary);
      });
    }
    if (!traces.length) {
      els.waveformPlot.style.height = '420px';
      Plotly.react(els.waveformPlot, [], {}, { responsive: true });
      return;
    }
    els.waveformPlot.style.height = '420px';
    const layout = {
      margin: { l: 65, r: 65, t: 20, b: 50 },
      paper_bgcolor: '#fff', plot_bgcolor: '#fff', hovermode: 'x unified', showlegend: false,
      xaxis: { title: 'Time from start (ms)', gridcolor: '#e7ffd9' },
      yaxis: { title: 'Voltage change (V)', zeroline: true, zerolinecolor: '#0a2f24' },
      yaxis2: { title: 'Current drop (A, reversed)', overlaying: 'y', side: 'right', zeroline: false, range: [70, 0], autorange: false, tickmode: 'array', tickvals: [0, 10, 20, 30, 40, 50, 60, 70], ticktext: ['0 A', '10 A', '20 A', '30 A', '40 A', '50 A', '60 A', '70 A'] }
    };
    Plotly.react(els.waveformPlot, traces, layout, { responsive: true, displaylogo: false });
  }

  function csvCell(value) { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
  function exportCsv() {
    const rows = [['test_id', 'sample', 'operation', 'source_file', 'time_s', 'current_a', 'voltage_v']];
    for (const record of state.active) for (let index = 0; index < record.time_s.length; index += 1) rows.push([record.test_id, record.sample, record.operation, record.source_file, record.time_s[index], record.current_a[index], record.voltage_v[index]]);
    download(new Blob([rows.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'ELECTRICAL_LIFE_EXPer_export.csv');
  }

  async function exportSqlite() {
    const SQL = await ensureSql();
    const database = new SQL.Database();
    database.run('CREATE TABLE _sheet_manifest (sheet_order INTEGER PRIMARY KEY, sheet_name TEXT NOT NULL, csv_file TEXT NOT NULL, sqlite_table TEXT NOT NULL, data_rows INTEGER NOT NULL, column_count INTEGER NOT NULL)');
    database.run('CREATE TABLE electrical_life_operations (test_id TEXT, sample TEXT, operation INTEGER, source_file TEXT, dt_s REAL, n_samples INTEGER, window_ms REAL, initial_current_a REAL, final_current_a REAL, peak_voltage_v REAL, i2t_a2s REAL, final_zero INTEGER)');
    database.run('CREATE TABLE electrical_life_waveform (test_id TEXT, sample TEXT, operation INTEGER, source_file TEXT, time_s REAL, current_a REAL, voltage_v REAL)');
    database.run('CREATE TABLE electrical_life_skipped (test_id TEXT, sample TEXT, source_file TEXT, reason TEXT)');
    const opStmt = database.prepare('INSERT INTO electrical_life_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const wfStmt = database.prepare('INSERT INTO electrical_life_waveform VALUES (?,?,?,?,?,?,?)');
    for (const record of state.active) {
      opStmt.run([record.test_id, record.sample, record.operation, record.source_file, record.dt_s, record.n_samples, record.window_ms, record.initial_current_a, record.final_current_a, record.peak_voltage_v, record.i2t_a2s, record.final_zero]); opStmt.reset();
      for (let index = 0; index < record.time_s.length; index += 1) { wfStmt.run([record.test_id, record.sample, record.operation, record.source_file, record.time_s[index], record.current_a[index], record.voltage_v[index]]); wfStmt.reset(); }
    }
    opStmt.free(); wfStmt.free();
    database.run('INSERT INTO _sheet_manifest VALUES (?,?,?,?,?,?)', [1, 'Electrical Life Operations', 'electrical_life_operations.csv', 'electrical_life_operations', state.active.length, 12]);
    database.run('INSERT INTO _sheet_manifest VALUES (?,?,?,?,?,?)', [2, 'Electrical Life Waveform', 'electrical_life_waveform.csv', 'electrical_life_waveform', state.active.reduce((sum, row) => sum + row.time_s.length, 0), 7]);
    const bytes = database.export(); database.close(); download(new Blob([bytes], { type: 'application/vnd.sqlite3' }), 'ELECTRICAL_LIFE_EXPer_export.sqlite');
  }

  function download(blob, name) { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }

  els.loadBundled.addEventListener('click', loadBundled);
  els.dataImportInput.addEventListener('change', async event => {
    try { await importDataFiles([...event.target.files]); }
    catch (error) { status(`Data import failed: ${error.message}`, true); }
    finally { event.target.value = ''; }
  });
  els.tdmsInput.addEventListener('change', async event => { try { await importTdms([...event.target.files]); } catch (error) { status(`TDMS import failed: ${error.message}`, true); } });
  els.mergeBundled.addEventListener('change', refreshActive);
  els.clearImported.addEventListener('click', () => {
    state.fileImported = [];
    state.imported = [];
    state.skipped = state.skipped.filter(row => row.test_id !== 'IMPORTED_TDMS');
    refreshActive();
    status('Imported records cleared.');
  });
  els.exportCsv.addEventListener('click', exportCsv);
  els.exportSqlite.addEventListener('click', () => exportSqlite().catch(error => status(`SQLite export failed: ${error.message}`, true)));
  let waveformResizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(waveformResizeTimer);
    waveformResizeTimer = setTimeout(renderSelectedWaveform, 150);
  });
  els.waveformRecordFilter.addEventListener('input', renderWaveformRecordSelector);
  els.waveformRecordSelectVisible.addEventListener('click', () => {
    state.selectedWaveformRecords = new Set([...els.waveformRecordList.querySelectorAll('input[data-record-key]')].map(input => input.dataset.recordKey));
    renderWaveformRecordSelector();
    renderSelectedWaveform();
  });
  els.waveformRecordClear.addEventListener('click', () => {
    state.selectedWaveformRecords.clear();
    renderWaveformRecordSelector();
    renderSelectedWaveform();
  });
  renderWaveformRecordSelector();
  loadBundled();
})();
