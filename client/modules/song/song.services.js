app.factory('Song', function() {
  function Song(url) {
    this.url = url;
  }

  Song.prototype.getMeta = function() {
    return $http.get(this.url);
  }

  return Song;
});


