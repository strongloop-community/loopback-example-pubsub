// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

app.factory('pubsubClient', function() {
  return require('pubsub-client')(3000);
});
