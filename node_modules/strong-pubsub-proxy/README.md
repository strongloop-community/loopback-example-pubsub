# strong-pubsub-proxy

**Create a bridge between a `Client` and a broker.**

## Installation

```
$ npm install strong-pubsub-proxy
```

## Use

Use `Proxy` for the following:

 - Bridge connections to brokers
 - Inject logic inbetween client actions (publish / subscribe / etc) and brokers
 - Adapt a connection that speaks one protocol to a broker that requires another 

**TCP**

Below is an example accepting a **tcp** connection, upgrading it to a
**strong-pubsub** `Connection`, and creating a bridge to an **MQTT** broker.

```js
// tcp server
tcpServer.on('connection', function(socket) {
  var proxy = new Proxy(
    // upgrade the tcp socket into a strong-pubsub-connection
    new Connection(socket),
    new Client({port: MOSQUITTO_PORT}, Adapter)
  );

  proxy.connect();
});
```

**Primus**

Here is an example that upgrades a **primus** `Spark` into a
**strong-pubsub** `Connection` and creating a bridge to an **MQTT** broker.

```js
// primus server
primus.on('connection', function(spark) {
  var proxy = new Proxy(
    new Connection(spark),
    new Client({port: MOSQUITTO_PORT}, Adapter)
  );

  proxy.connect();
});
```

**Hooks**

Below is an example using a hook to inject a function to be invoked before an
action is performed by the proxy on behalf of a `Connection`.

```js
proxy.before(action, function(ctx, next) {
  console.log('about to publish to');
  console.log(ctx.topic); // => "my topic"
  next();
});
```

## API

[See the API docs.](http://apidocs.strongloop.com/strong-pubsub-proxy)
