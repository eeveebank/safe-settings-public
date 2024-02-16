// Configuring manually due to https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1773
const process = require('process')
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http')
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
