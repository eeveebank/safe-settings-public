// Configuring manually due to https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1773
const process = require('process')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
const { PinoInstrumentation } = require('@opentelemetry/instrumentation-pino')
const opentelemetry = require('@opentelemetry/sdk-node')
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc')
const { Resource } = require('@opentelemetry/resources')
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions')
const { W3CTraceContextPropagator } = require('@opentelemetry/core')

const { OTEL_EXPORTER_OTLP_ENDPOINT } = process.env

if (OTEL_EXPORTER_OTLP_ENDPOINT) {
  const traceExporter = new OTLPTraceExporter({
    url: new URL('/v1/traces', OTEL_EXPORTER_OTLP_ENDPOINT).toString()
  })

  const sdk = new opentelemetry.NodeSDK({
    textMapPropagator: new W3CTraceContextPropagator(),
    traceExporter,
    instrumentations: [
      new PinoInstrumentation({
        logHook: (span, record) => {
          const spanContext = span?.spanContext()

          if (!spanContext) {
            return
          }

          // Transform IDs from opentelemetry format to Datadog format
          // https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/?tab=nodejs)
          const { spanId, traceId } = spanContext
          const traceIdEnd = traceId.slice(traceId.length / 2)
          const datadogTraceId = BigInt(`0x${traceIdEnd}`).toString()
          const datadogSpanId = BigInt(`0x${spanId}`).toString()

          record['dd.trace_id'] = datadogTraceId
          record['dd.span_id'] = datadogSpanId
        }
      }),
      new HttpInstrumentation({
        ignoreIncomingPaths: ['/health', '/metrics', '/ping']
      })
    ],
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'safe-settings'
    })
  })

  sdk.start()

  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => console.log('Tracing terminated'))
      .catch((error) => console.error('Error terminating tracing', error))
      .finally(() => process.exit(0))
  })
} else {
  console.log('OTEL_EXPORTER_OTLP_ENDPOINT not set')
}
