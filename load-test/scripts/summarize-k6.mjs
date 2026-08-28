#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);

if (!files.length) {
  console.error('Usage: node load-test/scripts/summarize-k6.mjs load-test/out/*.json');
  process.exit(1);
}

function cell(value) {
  if (value == null || Number.isNaN(Number(value))) return 'n/a';
  return String(Math.round(Number(value)));
}

function runLabel(file) {
  const base = path.basename(file, '.json');
  const match = base.match(/(\d+)\s*vu/i) || base.match(/-(\d+)$/);
  return match ? `${match[1]} VUs` : base;
}

function metricValues(summary, key) {
  const metric = summary.metrics?.[key];
  if (!metric) return {};
  // k6 --summary-export puts the values directly on the metric object; the
  // handleSummary(data) shape nests them under .values. Support both.
  return metric.values || metric;
}

const endpoints = [
  ['health', 'http_req_duration{endpoint:health}'],
  ['deep_health', 'http_req_duration{endpoint:deep_health}'],
  ['lookups', 'http_req_duration{endpoint:lookups}'],
  ['treaty_list', 'http_req_duration{endpoint:treaty_list}'],
  ['quote_list', 'http_req_duration{endpoint:quote_list}'],
  ['treaty_detail', 'http_req_duration{endpoint:treaty_detail}'],
  ['prop_pricing', 'http_req_duration{endpoint:prop_pricing}'],
  ['quote_pricing', 'http_req_duration{endpoint:quote_pricing}'],
  ['np_structure', 'http_req_duration{endpoint:np_structure}'],
  ['np_pricing', 'http_req_duration{endpoint:np_pricing}'],
  ['dashboard', 'http_req_duration{endpoint:dashboard}'],
  ['agg_drilldown', 'http_req_duration{endpoint:agg_drilldown}'],
  ['quote_crud', 'http_req_duration{endpoint:quote_crud}'],
];

for (const file of files) {
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Rate metrics: .rate in the handleSummary shape, .value in --summary-export.
  const failedValues = metricValues(summary, 'http_req_failed');
  const errorRate = failedValues.rate ?? failedValues.value;
  const poolValues = metricValues(summary, 'pg_pool_waiting');
  const poolMax = poolValues.max ?? 0;

  console.log(`\n## ${runLabel(file)}`);
  console.log('');
  console.log(`- error rate: ${errorRate == null ? 'n/a' : `${(errorRate * 100).toFixed(2)}%`}`);
  console.log(`- pg_pool_waiting max: ${poolMax}`);
  console.log('');
  console.log('| endpoint | p50 ms | p95 ms | p99 ms | max ms |');
  console.log('| --- | ---: | ---: | ---: | ---: |');

  for (const [endpoint, metric] of endpoints) {
    const values = metricValues(summary, metric);
    if (!Object.keys(values).length) continue;
    console.log(`| ${endpoint} | ${cell(values.med)} | ${cell(values['p(95)'])} | ${cell(values['p(99)'])} | ${cell(values.max)} |`);
  }
}
