import * as fs from 'node:fs';
import * as path from 'node:path';

type MetricSummary = {
  count?: unknown;
  p50?: unknown;
  p95?: unknown;
  p99?: unknown;
};

type LatencyReport = {
  samplesRequested?: unknown;
  attempts?: unknown;
  successfulSamples?: unknown;
  failedSamples?: unknown;
  samples?: Array<{ ok?: unknown; dispatchMs?: unknown; bridgeVisibleOverheadMs?: unknown; phases?: unknown }>;
  summary?: {
    ttftMs?: MetricSummary;
    dispatchMs?: MetricSummary;
    upstreamToSseMs?: MetricSummary;
    bridgeVisibleOverheadMs?: MetricSummary;
  };
  comparison?: Record<string, unknown>;
};

const reportPath = process.env.GROK_M4_REPORT ?? path.join('artifacts', 'm4-final-native-output-comparison.json');
const maxDispatchP50Ms = numberEnv('GROK_M4_MAX_DISPATCH_P50_MS', 10);
const maxBridgeOverheadP50Ms = numberEnv('GROK_M4_MAX_BRIDGE_OVERHEAD_P50_MS', 50);
const maxNativeDeltaP50Ms = numberEnv('GROK_M4_MAX_NATIVE_DELTA_P50_MS', 500);
const requireBaseline = process.env.GROK_M4_REQUIRE_BASELINE !== '0';
const minDispatchP50ReductionPct = numberEnv('GROK_M4_MIN_DISPATCH_P50_REDUCTION_PCT', 50);
const minTtftP50ReductionPct = numberEnv('GROK_M4_MIN_TTFT_P50_REDUCTION_PCT', 30);
const minTtftP95ReductionPct = numberEnv('GROK_M4_MIN_TTFT_P95_REDUCTION_PCT', 30);

function main() {
  const report = readReport(reportPath);
  const failures: string[] = [];

  const requested = numberValue(report.samplesRequested);
  const successful = numberValue(report.successfulSamples);
  const successfulFromSamples = Array.isArray(report.samples)
    ? report.samples.filter((sample) => sample && sample.ok === true).length
    : null;
  const successCount = successful ?? successfulFromSamples;

  if (requested === null || requested < 30) {
    failures.push(`samplesRequested must be >= 30, got ${String(report.samplesRequested)}`);
  }
  if (successful === null) {
    failures.push('successfulSamples field is missing; rerun npm run test-latency with the current script');
  }
  if (requested !== null && successCount !== null && successCount < requested) {
    failures.push(`successful samples ${successCount}/${requested} did not meet requested count`);
  }

  requireMetric(report.summary?.ttftMs, 'ttftMs', failures);
  requireMetric(report.summary?.dispatchMs, 'dispatchMs', failures);
  requireMetric(report.summary?.bridgeVisibleOverheadMs, 'bridgeVisibleOverheadMs', failures);

  const dispatchP50 = numberValue(report.summary?.dispatchMs?.p50);
  if (dispatchP50 !== null && dispatchP50 > maxDispatchP50Ms) {
    failures.push(`dispatch p50 ${dispatchP50}ms exceeds ${maxDispatchP50Ms}ms`);
  }

  const bridgeOverheadP50 = numberValue(report.summary?.bridgeVisibleOverheadMs?.p50);
  if (bridgeOverheadP50 !== null && bridgeOverheadP50 > maxBridgeOverheadP50Ms) {
    failures.push(`bridge overhead p50 ${bridgeOverheadP50}ms exceeds ${maxBridgeOverheadP50Ms}ms`);
  }

  const nativeComparison = nativeComparisonSummary(report.comparison);
  if (!nativeComparison.present) {
    failures.push('native Grok comparison is missing');
  } else if (nativeComparison.deltaP50Ms === null) {
    failures.push('native Grok comparison is missing numeric p50 delta');
  } else if (nativeComparison.deltaP50Ms !== null && Math.abs(nativeComparison.deltaP50Ms) > maxNativeDeltaP50Ms) {
    failures.push(
      `native p50 delta ${nativeComparison.deltaP50Ms}ms exceeds +/-${maxNativeDeltaP50Ms}ms`,
    );
  }

  const baselineComparison = baselineComparisonSummary(report.comparison);
  if (!baselineComparison.present) {
    if (requireBaseline) {
      failures.push('baseline comparison is missing');
    }
  } else {
    if (
      baselineComparison.dispatchP50ReductionPct === null ||
      baselineComparison.dispatchP50ReductionPct < minDispatchP50ReductionPct
    ) {
      failures.push(
        `dispatch p50 reduction ${formatReduction(baselineComparison.dispatchP50ReductionPct)} is below ${minDispatchP50ReductionPct}%`,
      );
    }
    if (
      baselineComparison.ttftP50ReductionPct === null ||
      baselineComparison.ttftP50ReductionPct < minTtftP50ReductionPct
    ) {
      failures.push(
        `TTFT p50 reduction ${formatReduction(baselineComparison.ttftP50ReductionPct)} is below ${minTtftP50ReductionPct}%`,
      );
    }
    if (
      baselineComparison.ttftP95ReductionPct === null ||
      baselineComparison.ttftP95ReductionPct < minTtftP95ReductionPct
    ) {
      failures.push(
        `TTFT p95 reduction ${formatReduction(baselineComparison.ttftP95ReductionPct)} is below ${minTtftP95ReductionPct}%`,
      );
    }
  }

  const requiredPhaseNames = [
    'jobQueuedAt',
    'workerNotifiedAt',
    'workerAcceptedAt',
    'grokFetchStartedAt',
    'firstRawUpstreamChunkAt',
    'firstSseChunkAt',
  ];
  const samples = Array.isArray(report.samples) ? report.samples.filter((sample) => sample.ok === true) : [];
  for (const name of requiredPhaseNames) {
    if (!samples.every((sample) => sample.phases && typeof (sample.phases as Record<string, unknown>)[name] === 'number')) {
      failures.push(`successful samples are missing phase ${name}`);
    }
  }

  if (failures.length > 0) {
    console.error(`M4 evidence verification failed for ${path.resolve(reportPath)}:`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`PASS M4 evidence: ${path.resolve(reportPath)}`);
  console.log(`successful=${successCount}/${requested}`);
  console.log(`dispatch.p50=${dispatchP50}ms`);
  console.log(`bridgeOverhead.p50=${bridgeOverheadP50}ms`);
  console.log(`nativeDelta.p50=${nativeComparison.deltaP50Ms ?? 'available'}`);
  console.log(`baseline.ttftP50Reduction=${formatReduction(baselineComparison.ttftP50ReductionPct)}`);
  console.log(`baseline.dispatchP50Reduction=${formatReduction(baselineComparison.dispatchP50ReductionPct)}`);
}

function readReport(filePath: string): LatencyReport {
  const resolved = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as LatencyReport;
}

function requireMetric(metric: MetricSummary | undefined, name: string, failures: string[]): void {
  if (!metric || numberValue(metric.count) === null || numberValue(metric.p50) === null) {
    failures.push(`summary.${name} is missing count/p50`);
  }
}

function nativeComparisonSummary(comparison: Record<string, unknown> | undefined): {
  present: boolean;
  deltaP50Ms: number | null;
} {
  if (!comparison) {
    return { present: false, deltaP50Ms: null };
  }

  const nativeEndpoint = comparison.nativeEndpoint as Record<string, unknown> | undefined;
  if (
    nativeEndpoint &&
    numberValue(nativeEndpoint.count) !== null &&
    Number(nativeEndpoint.count) > 0
  ) {
    return { present: true, deltaP50Ms: numberValue(nativeEndpoint.deltaP50Ms) };
  }

  const nativeReport = comparison.nativeReport as Record<string, unknown> | undefined;
  if (nativeReport) {
    return { present: true, deltaP50Ms: numberValue(nativeReport.ttftP50DeltaMs) };
  }

  const nativeTtft = comparison.nativeTtftMs as Record<string, unknown> | undefined;
  if (nativeTtft) {
    return { present: true, deltaP50Ms: numberValue(nativeTtft.deltaP50Ms) };
  }

  return { present: false, deltaP50Ms: null };
}

function baselineComparisonSummary(comparison: Record<string, unknown> | undefined): {
  present: boolean;
  ttftP50ReductionPct: number | null;
  ttftP95ReductionPct: number | null;
  dispatchP50ReductionPct: number | null;
} {
  const baseline = comparison?.baseline as Record<string, unknown> | undefined;
  if (!baseline) {
    return {
      present: false,
      ttftP50ReductionPct: null,
      ttftP95ReductionPct: null,
      dispatchP50ReductionPct: null,
    };
  }

  return {
    present: true,
    ttftP50ReductionPct: numberValue(baseline.ttftP50ReductionPct),
    ttftP95ReductionPct: numberValue(baseline.ttftP95ReductionPct),
    dispatchP50ReductionPct: numberValue(baseline.dispatchP50ReductionPct),
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function formatReduction(value: number | null): string {
  return value === null ? 'missing' : `${value.toFixed(2)}%`;
}

main();
