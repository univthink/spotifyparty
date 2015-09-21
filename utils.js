var monk = require('monk');
var fs = require('fs');
var ObjectID = require('mongodb').ObjectID;
var SpotifyWebApi = require('spotify-web-api-node');

var transform = require('./query/transform')

var db = monk('localhost:27017/queueup');
var spotifyConfig = JSON.parse(fs.readFileSync(__dirname + '/spotify.key', {encoding: 'utf8'}));

exports.normalizeName = function (name) {
  return name.replace(/[^\w]/gi,'').toLowerCase();
}

exports.getSpotifyApiForUser = function (user, callback) {
  if (user) {
    var spotifyApi = new SpotifyWebApi(spotifyConfig);

    spotifyApi.setAccessToken(user.spotify.accessToken);
    spotifyApi.setRefreshToken(user.spotify.refreshToken);

    // If accessToken has expired
    if (user.spotify.tokenExpiration < new Date().getTime()) {
      spotifyApi.refreshAccessToken().then(function (data) {
        user.spotify.accessToken = data.access_token;
        user.spotify.tokenExpiration = (data.expires_in * 1000) + new Date().getTime();

        spotifyApi.setAccessToken(data.access_token);
        callback(null, spotifyApi, user);
      }, function (err) {
        callback(err);
      });      
    } else {
      callback(null, spotifyApi);
    }


  } else {
    callback(new Error("Invalid user"));
  }
}

exports.getUserPlaylistTracks = function (user, playlist, callback) {
  if (user && playlist) {
    getSpotifyApiForUser(user, playlist);
  } else {
    callback(new Error("User or playlist is undefined"));
  }
}

exports.skipTrack = function (playlist, callback) {
  
  transform.playlist(playlist, function (playlist) {
    /* If there's anything in the queue */
    if (playlist.tracks && playlist.tracks.length > 0) {

      /* Store the first track */
      var first = playlist.tracks[0];
      console.log("Removing: ", first.track.id);

      /* Remove the first track from the DB, set the current as the stored track */
      db.get('playlists').findAndModify({
        _id: playlist._id
      }, {
        $set: {
          current: first.track,
          last_updated: new Date().getTime()
        },
        $pull: {tracks: { _id: first._id}}
      }, {
        "new": true
      }).success(function (playlist) {

        transform.playlist(playlist, function (transformed) {
          callback(playlist);
        });

      }).error(function (err) {
        callback(null, {error: err});
      });

    } else {
      db.get('playlists').findAndModify({
        _id: playlist._id
      }, {
        $set: {current: null}
      }, {
        "new": true
      }).success(function (playlist) {

        transform.playlist(playlist, function (transformed) {
          callback(playlist);
        });

      }).error(function (err) {
        callback(null, err);
      });

    }
  });
}

exports.userIsPlaylistAdmin = function (user, playlist) {
  if (!user || !playlist) {
    return false;
  }
  return (user._id.equals(playlist.admin));
}

exports.updateUser = function (user, update, callback) {
  db.get('user').update({
    _id: user._id
  }, { $set: update }).error(function (err) {
    if (callback) {
      callback(err);    
    }
  }).success(function(record) {
    if (callback) {
      callback(record);
    }
  });
}

exports.addTrackToPlaylist = function (req, trackId, playlist, callback) {
  /* First get the track information from Spotify */

  var apiUser = req.apiUser;
  var user = (user) ? {_id: apiUser._id, name: apiUser.name } : null;

  req.spotify.getTrack(trackId).then(function(response) {
    var track = response.body;

    /* This keeps on the fields we want */
    track = exports.objCopy(track, {"name": true,"duration_ms": true, "id": true, "uri": true, "artists": true, "album.id": true, "album.images": true, "album.name": true, "album.uri": true});

    /* track should be defined if Spotify found a valid track */
    if (track) {

      /* If there isn't a current track, don't put this in the queue */
      if (!playlist.current) {

        /* Set the current track to the one just added */
        req.db.get('playlists').findAndModify(
          {_id: playlist._id},
          {
            $set: { current: track }
          }, { "new": true }
        ).success(function(playlist) {

          /* playlist found in DB */
          exports.emitStateChange(req.io, playlist, "add_track");

          callback(null, playlist);

        }).error(function (err) {
          req.json({error: err});
        });

      /* Add the track to the end of the queue */
      } else {


        /* Append the track */
        req.db.get('playlists').findAndModify(
          {_id: playlist._id},
          {
            $push: {
              tracks: {
                _id: new ObjectID(),
                track: track,
                dateAdded: new Date().getTime(),
                addedBy: user
              }
            }
          }, {"new": true}
        ).success(function (playlist) {
        
          /* Added successfully */
          console.log("Added track: ", track.id);

          exports.emitStateChange(req.io, playlist, "add_track_queue");
          
          callback(null, playlist);
        }).error(function (err) {
          console.log(err);
        });
      }
    } else {
      /* If the response from Spotify was undefined */
      callback({
        error: "Track not found",
        message: "TrackID: " + req.params.trackid
      });
    }
    
  });
}

exports.voteOnTrack = function (apiUserId, playlistId, trackId, upvote, success, badRequest, error) {
  
  var Playlists = db.get('playlists');

  /* First get playlist and track where the user is a voter */
  Playlists.findOne({
    _id: playlistId,
    tracks: {
      $elemMatch: {
        _id: ObjectID(trackId),
        voters: {
          $elemMatch: {
            _id: apiUserId
          }
        }
      }
    }
  }).success(function (playlist) {

    var updateQuery;

    console.log("Voting", upvote);

    /* If we are to add a vote and the user isn't already a voter on the track */
    if (upvote && !playlist) {

      /* Increments the votes and pushes the user to the list */
      updateQuery = {
        $inc: {
          "tracks.$.votes": 1
        },
        $push: {
          "tracks.$.voters": {
            _id: apiUserId
          }
        }
      };

    /* If the user is a voter and we are removing the vote */
    } else if (!upvote && playlist) {

      /* Decrement and remove the voter */
      updateQuery = {
        $inc: {
        "tracks.$.votes": -1
        },
        $pull: {
          "tracks.$.voters": {
            _id: apiUserId
          }
        }
      };
    } else {
      if (upvote) {
        badRequest("The user has already voted on this track");
      } else {
        badRequest("The user hasn't voted on this track yet");  
      }
    }

    /* If we have a valid scenario */
    if (updateQuery) {

      /* Do the update */
      Playlists.findAndModify({
        _id: playlistId,
        "tracks._id": ObjectID(trackId)
      }, updateQuery, {
        "new": true
      }).success(function (newPlaylist) {

        /* If the track hasn't disappeared for some reason since last check*/
        if (newPlaylist != null) {

          success(newPlaylist);
        } else {
          console.log("No track found in playlist");
          badRequest("No track found in playlist");
        }

        
      }).error(function (err) {
        error(err);
      });
    } 

  }).error(function (err) {
    error(err);
  });


}


/* Broadcast to every listener in the 'room' */
exports.emitStateChange = function (io, playlist, proj, trigger) {

  // TODO: IMPLEMENT PROJECTIONS
  if (typeof (proj) == "string") {
    trigger = proj;
  }

  console.log("emitting state change: ", playlist);

  /* Transform with the current state (playlist field is required) */
  transform.playlist(playlist, function (playlist) {

    /* Send update */
    io.to(playlist._id).emit('state_change', {
      play: playlist.play,
      track: playlist.current,
      queue: playlist.tracks,
      trigger: trigger
    });
  });

}


/* Send to specific client */
exports.sendStateChange = function (socket, playlist, trigger) {

  /* Transform with state */
  transform.playlist(playlist, function (playlist) {
    /* Send update */
    socket.emit('state_change', {
      play: playlist.play,
      track: playlist.current,
      queue: playlist.tracks,
      trigger: trigger
    });
  });

}

exports.trackSimplify = function (track) {
  return {
  }
}

/** 
  This returns a copy of the object, but with the set of 'keep' fields retained.
  Inner objects can be retained using "." between fields.
*/
exports.objCopy = function (object, keep) {
  function copyObjField(object, fields, input) {
    var o = (input) ? input : undefined;

    if (fields.length >= 1) {
      if (!o) { o = {} };
      var top = fields.splice(0,1)[0];
      var value = object[top];
      if (value) {
        o[top] = (fields.length == 0) ? value : copyObjField(value, fields, o[top]);
      }
    }
    return o;
  }

  var result = {};
  if (keep) {
    for (key in keep) {
      copyObjField(object, key.split('.'), result)
    }
  }
  return result;
}
