const prom = require('prom-client');
prom.collectDefaultMetrics();
const requests = new prom.Counter({
  name: 'http_requests_total', help: 'HTTP requests', labelNames: ['route','method','status']
});
const latency = new prom.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP request latency',
  labelNames: ['route','method'], buckets: [0.05,0.1,0.25,0.5,1,2,5,10]
});
const sarvamLatency = new prom.Histogram({
  name: 'sarvam_latency_seconds', help: 'Sarvam API latency',
  buckets: [0.1,0.25,0.5,1,2,5,10]
});
const photoErrors = new prom.Counter({ name:'photo_match_errors_total', help:'Photo match errors' });
const queueLength = new prom.Gauge({ name:'queue_length', help:'Families currently waiting in stage queue' });
function middleware(req,res,next) {
  const end = latency.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path;
    requests.inc({ route, method:req.method, status:String(res.statusCode) });
    end({ route, method:req.method });
  });
  next();
}
module.exports = { prom, middleware, sarvamLatency, photoErrors, queueLength };
