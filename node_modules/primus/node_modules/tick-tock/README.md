# tick-tock

[![Made by unshift](https://img.shields.io/badge/made%20by-unshift-00ffcc.svg?style=flat-square)](http://unshift.io)[![Version npm](http://img.shields.io/npm/v/tick-tock.svg?style=flat-square)](http://browsenpm.org/package/tick-tock)[![Build Status](http://img.shields.io/travis/unshiftio/tick-tock/master.svg?style=flat-square)](https://travis-ci.org/unshiftio/tick-tock)[![Dependencies](https://img.shields.io/david/unshiftio/tick-tock.svg?style=flat-square)](https://david-dm.org/unshiftio/tick-tock)[![Coverage Status](http://img.shields.io/coveralls/unshiftio/tick-tock/master.svg?style=flat-square)](https://coveralls.io/r/unshiftio/tick-tock?branch=master)[![IRC channel](http://img.shields.io/badge/IRC-irc.freenode.net%23unshift-00a8ff.svg?style=flat-square)](http://webchat.freenode.net/?channels=unshift)

`tick-tock` is a small timer and `setTimeout` management library. Nothing to
fancy, but fancy enough to make your code more readable.

## Installation

This library can be used with both browserify and node.js and can be installed
using npm:

```
npm install --save tick-tock
```

## Usage

In all example we assume that you've required and initialized the library using:

```js
'use strict';

var Tick = require('tick-tock')
  , tock = new Tick();
```

All methods return `this` unless stated otherwise. The constructor can be
initialized with 1 argument:

1. `context` This is the default context in which each `setTimeout` or
   `setInterval` function is executed (it sets the `this` value). If nothing is
   supplied it will default to your `tick-tock` instance.

The following methods are available on your constructed instance:

- [Tock.setTimeout(name, fn, timeout)](#tocksettimeout)
- [Tock.setInterval(name, fn, interval)](#tocksetinterval)
- [Tock.clear(name, name, ..)](#tockclear)
- [Tock.active(name)](#tockactive)
- [Tock.adjust(name, duration)](#tockadjust)
- [Tock.end()](#tockend)

### Tock.setTimeout()

The `setTimeout` method adds as you might have expected.. a new setTimeout. The
timeouts are stored based on the name that your provide them. If you've already
stored a timer with the given name, it will add the supplied callback to the
same stack so only one timer is used and they all run at the same time. Normally
you would supply the `setTimeout` method with a number indicating long it should
timeout. In this library we also support human readable strings.

```js
tock.setTimeout('foo', function () {}, 10);

// Ran at the same point in time as the timeout above
setTimeout(function () {
  tock.setTimeout('foo', function () {}, 10); 
}, 5);

tock.setTimeout('another', function () {}, '10 minutes');
```

### Tock.setInterval()

Exactly the same method and functionality as above but instead of only being
called once, it will called at an interval.

### Tock.clear()

The `clear` method allows you to clear every stored timeout by name. You can
supply it multiple arguments (strings) to clear all given timers and if you
supply 1 strings it can be comma separated list of names. If no arguments are
supplied it will clear all timers in this instance.

```js
tock.clear('foo', 'bar');
tock.clear('foo, bar'); // Same as above.
tock.clear(); // Nuke everything.
```

### Tock.active()

Check if there's an active timer for the given name and returns a boolean.

```js
tock.active('foo'); // true;
tock.clear();
tock.active('foo'); // false;
```

### Tock.adjust()

There are cases where you sometimes need to update or change the interval of an
`setTimeout` or `setInterval` for example in the case of a setTimeout which
coordinates a heartbeat. In order to make this easier you call the `.adjust`
method with the name of the timeout that you want to adjust and the new
interval/timeout.

```js
tock.setTimeout('heartbeat timeout', function () {});

// you recieved a new heartbeat so you want to reset or adjust the heartbeat;
tock.adjust('heartbeat timeout', '1 second');
```

### Tock.end()

You no longer wish to interact with your instance and wants it to be fully shut
down. This kills all active timers using `tock.clear()` and nulls the internal
properties. It will return `true` if it's the first time it's destroyed and
`false` if was already destroyed before. If you call any of the other methods
after destruction, they will throw errors.

```js
tock.end();
```

## License

MIT
