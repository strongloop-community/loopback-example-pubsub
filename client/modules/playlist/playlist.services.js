app.factory('Playlist', function($http, Song, pubsubClient) {
  function Playlist(id) {
    var playlist = this;
    this.id = id || generateId();
    this.songs = [];

    this.subscribe();

    pubsubClient.on('message', function(topic, msg) {
      var id;
      if(topic.indexOf(playlist.getTopic()) === 0) {
        id = parseInt(msg.toString());
        playlist.onSongChanged(id);
      }
    });
  }

  Playlist.prototype.onSongChanged = function(id) {
    var songExists = false;
    var playlist = this;

    this.songs.forEach(function(song) {
      if(song.id === id) {
        songExists = true;
        playlist.updateSong(song);
      }
    });

    if(!songExists) {
      playlist.addSongById(id);
    }
  }

  Playlist.prototype.updateSong = function(song) {
    console.log('updateSong');
    Song.findById({
      id: song.id
    }, function(latest) {
      Object.keys(latest).forEach(function(key) {
        // update in place (angular will update the ui)
        song[key] = latest[key];
      });
    });
  }

  Playlist.prototype.addSongById = function(id) {
    var playlist = this;

    Song.findById({
      id: id
    }, function(song) {
      playlist.songs.push(song);
    });
  }

  Playlist.prototype.addSong = function(url) {
    var id = this.id;
    var song = {
      playlist: id,
      scURL: url
    };
    var playlist = this;


    return Song.create(song, function(createdSong) {
      playlist.songs.push(createdSong);
    });
  }

  Playlist.prototype.getSongs = function() {
    this.songs = Song.find({
      filter: {where: {playlist: this.id}}
    });
  }

  Playlist.prototype.subscribe = function() {
    pubsubClient.subscribe(this.getTopic());
  }

  Playlist.prototype.getTopic = function() {
    return '/playlists/' + this.id;
  }

  function generateId() {
    var n = Math.random();
    return n.toString().split('.')[1].toString();
  }

  return Playlist;
});
