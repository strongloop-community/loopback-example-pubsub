// Copyright IBM Corp. 2015. All Rights Reserved.
// Node module: loopback-example-pubsub
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

app.factory('Song', function() {
  function Song(url) {
    this.url = url;
  }

  Song.prototype.getMeta = function() {
    return $http.get(this.url);
  }

  return Song;
});


