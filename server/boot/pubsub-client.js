// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

var path = require('path');
var browserify = require('browserify');

module.exports = function(app) {
  app.get('/pubsub-client.js', function(req, res) {
    var b = browserify({
      basedir: __dirname,
      debug: true
    });

    b.require(path.join(__dirname, '..', '..',
      'client', 'js', 'pubsub-client.js'), {expose: 'pubsub-client'});

    b.bundle().pipe(res);
  });
};
