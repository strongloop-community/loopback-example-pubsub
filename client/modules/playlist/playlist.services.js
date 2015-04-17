app.factory('Playlist', function($http, Song, pubsubClient) {
  function Playlist(id) {
    this.id = id || generateId();
    this.songs = [];

    this.subscribe();
  }

  Playlist.prototype.addSong = function(url) {
    var id = this.id;
    var song = {
      playlist: id,
      scURL: url
    };

    this.songs.push(song);

    return Song.create(song);
  }

  Playlist.prototype.getSongs = function() {
    this.songs = Song.find();
  }

  Playlist.prototype.subscribe = function() {
    pubsubClient.subscribe(this.id);
  }


  function generateId() {
    var n = Math.random();
    return n.toString().split('.')[1].toString();
  }

  return Playlist;
});
