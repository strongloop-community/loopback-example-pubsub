# demolish

[![Made by unshift][made-by]](http://unshift.io)[![Version npm][version]](http://browsenpm.org/package/demolish)[![Build Status][build]](https://travis-ci.org/unshiftio/demolish)[![Dependencies][david]](https://david-dm.org/unshiftio/demolish)[![Coverage Status][cover]](https://coveralls.io/r/unshiftio/demolish?branch=master)[![IRC channel][irc]](http://webchat.freenode.net/?channels=unshift)

[made-by]: https://img.shields.io/badge/made%20by-unshift-00ffcc.svg?style=flat-square
[version]: https://img.shields.io/npm/v/demolish.svg?style=flat-square
[build]: https://img.shields.io/travis/unshiftio/demolish/master.svg?style=flat-square
[david]: https://img.shields.io/david/unshiftio/demolish.svg?style=flat-square
[cover]: https://img.shields.io/coveralls/unshiftio/demolish/master.svg?style=flat-square
[irc]: https://img.shields.io/badge/IRC-irc.freenode.net%23unshift-00a8ff.svg?style=flat-square

Demolish is a small module which helps you clean, release and destroy your
created instances.

## Install

This module is intended for Node.js and Browserify usage and can be installed
using:

```
npm install --save demolish
```

## Usage

The module is exported as a function and be required as following:

```js
'use strict';

var demolish = require('demolish');
```

The `demolish` function returns a function which will destroy the specified
properties from your instance.

```js
function Foo() {
  this.bar = 1;
  this.banana = new Banana();
}

Foo.prototype.destroy = demolish('bar banana');
```

In the example above we've created a new `destroy` method on our `Foo` class.
Once the method is called it will set the `bar` property to `null` and check if
`banana` also has a `destroy` method, if so, it will call that method and set
the property to `null` after the execution.

After everything is cleaned up we will emit a `destroy` event if there is an
`emit` method available.

The `destroy` method will automatically prevent double execution by checking if
the first supplied property is still active on the prototype. So in the example
above it will check if `bar` is not `null`.

But nulling objects and destroying things you've set on an instance might not be
enough. Sometimes you need a bit more and for those cases we have the additional
`before` and `after` hooks. These hooks can be specified in the options:

```js
Foo.prototype.destroy = demolish('bar banana', {
  before: 'clear',
  after: ['removeAllListeners', function () {
    // things
  }]
});
```

In the example above you see all the supported styles. If you supply a string
we assume that it's a function on the prototype that needs to be executed in order
to clean up things correctly. If you need to run multiple tasks you can supply
an array with strings. In addition to strings we also support functions, these
functions will be called with their `this` value set to the instance of the class
where `destroy` works.

So in the example above the execution flow is the following:

1. Check if `destroy` has already been called, if not, continue to step 2.
2. Execute the before hook.
3. Iterate over all properties that need to be destroyed and nulled.
4. Emit the `destroy` event, where possible.
5. Execute the after hook.

## License

MIT
