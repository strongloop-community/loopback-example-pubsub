# Recovery

[![Made by unshift][made-by]](http://unshift.io)[![Version npm][version]](http://browsenpm.org/package/recovery)[![Build Status][build]](https://travis-ci.org/unshiftio/recovery)[![Dependencies][david]](https://david-dm.org/unshiftio/recovery)[![Coverage Status][cover]](https://coveralls.io/r/unshiftio/recovery?branch=master)[![IRC channel][irc]](http://webchat.freenode.net/?channels=unshift)

[made-by]: https://img.shields.io/badge/made%20by-unshift-00ffcc.svg?style=flat-square
[version]: https://img.shields.io/npm/v/recovery.svg?style=flat-square
[build]: https://img.shields.io/travis/unshiftio/recovery/master.svg?style=flat-square
[david]: https://img.shields.io/david/unshiftio/recovery.svg?style=flat-square
[cover]: https://img.shields.io/coveralls/unshiftio/recovery/master.svg?style=flat-square
[irc]: https://img.shields.io/badge/IRC-irc.freenode.net%23unshift-00a8ff.svg?style=flat-square

Recovery provides randomized exponential back off for reconnection attempts. It
allows you to recover the connection in the most optimal way (for both server
and client). The exponential back off is randomized to prevent a DDOS like
attack on your server when it's restarted, spreading the reconnection attempts
instead of having all your connections attempt to reconnect at exactly the same
time.

### Features

- Reconnection and progress events.
- Randomized exponential back off.
- Reconnection timeouts.
- Browserify compatible.

The code base of this module was originally written for [Primus] but has been
extracted as separate module. It has been thoroughly tested and it's written
with love `<3`

## Installation

As this module can be used with node.js and browserify it's released in the `npm`
registry and can be installed using:

```
npm install --save recovery
```

## Events

As mentioned in the documentation introduction, this library provides various of
reconnection and progress events. Events **always** receive a "status" or
progress object as last argument. This object contains useful information about
current reconnection progress:

- `attempt`:  Which reconnection attempt are we currently processing.
- `start`: Starting time of reconnection attempt.
- `duration`: How long have we taken so far to establish the connection.
- `scheduled`: In how many ms do we schedule the next reconnection attempt.

In addition to these values it also contains all the configuration options like
`retries`, `min`, `max` etc.

The following events are emitted during the recovery process:

Event                 | Arguments   | Description
----------------------|-------------|-----------------------------------------------------
`reconnect scheduled` | status      | Scheduled a new reconnection attempt.
`reconnect`           | status, fn  | It's time for you to reconnect to the server.
`reconnected`         | status      | Successfully reconnected.
`reconnect failed`    | err, status | Failed to reconnect and ran out of attempts.
`reconnect timeout`   | err, status | Failed to reconnect in a timely manner, will retry.

## Constructing

In all code examples we assume that you've loaded the library using:

```js
'use strict';

var Recovery = require('recovery');
```

The module is exported as a constructor. The constructor accepts an optional
options object which allows you to configure the reconnection procedure.
The following options are accepted:

- `max` Maximum reconnection delay. Defaults to `Infinity`.
- `min` Minimum reconnection delay. Defaults to `500 ms`.
- `retries` Maximum amount retries after this we will emit an `reconnect failed`
  event. Defaults to `10`.
- `reconnect timeout` Time you have to reconnect to the server. If it takes
  longer than the specified value we will emit an `reconnect timeout` event and
  schedule another reconnection attempt. Defaults to `30 seconds`.
- `factor` Exponential back off factor. Defaults to `2`.

Options that indicate a time can either be set using a human readable string
like `10 seconds`, `1 day`, `10 ms` etc. or a numeric value which represents the
time in milliseconds.

```js
var recovery = new Recovery({
  max: '30 seconds',
  min: '100 milliseconds',
  retries: 5
});
```

### Reconnecting

Before every reconnection attempt we emit a `reconnect` event. You can listen
to this event on your assigned event emitter. After the event is emitted
we will start a timeout so your attempts have only a limited amount of time to
succeed or fail. If the timeout expires we emit a `reconnect timeout` event and
start a whole new reconnection procedure.

If your reconnection attempt is successful call the `reconnect.reconnected()`
method without any arguments. If it failed you can call the method with an error
argument. If the operation failed we will automatically schedule a new reconnect
attempt. When it's successful we will do some small internal clean up and emit
the `reconnected` event. If all future attempts fail we will eventually emit the
`reconnect failed` event which basically indicates that something horrible is
going on.

```js
recovery = new Recovery();

recovery.on('reconnect', function (opts) {
  console.log(opts.attempt);

  reconnectmyconnection(function (err) {
    if (err) return reconnect.reconnected(err);
    reconnect.reconnected();
  });
});

recovery.reconnect();
```

Alternatively you also call the callback which is provided in the `reconnect`
event which is the same as the `reconnected` method.

```js
recovery.on('reconnect', function (opts, fn) {
  reconnectmyconnection(fn);
});
```

To check if a reconnection attempt is already running you can call the
`reconnecting` method which will return a boolean:

```js
if (!recovery.reconnecting()) recovery.reconnect();
```

And if you wish to cancel the running reconnection attempt you can call the
`reset` method:

```js
if (recovery.reconnecting()) recovery.reset();
```

## License

MIT

[Primus]: http://primus.io
