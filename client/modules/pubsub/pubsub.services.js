app.factory('pubsubClient', function() {
  return require('pubsub-client')(3000);
});
