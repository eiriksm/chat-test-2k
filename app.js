'use strict';
var rdb = {};
// Used for setting up tables laters.
var tables = {
  'messages': 'id',
  'cache': 'cid',
  'users': 'id'
};

var express = require('express');
var app = express();
var server = require('http').createServer(app);
var passport = require('passport');
var flash = require('connect-flash');
var local = require('passport-local').Strategy;
var r = require('rethinkdb');
var bcrypt = require('bcrypt');
var io = require('socket.io').listen(server);
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var session = require('express-session');

app.use(express.static('public'));
app.use(cookieParser());
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');
app.use(bodyParser.urlencoded({ extended: false }));

app.use(session({ secret: 'keyboard cat' }));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

/**
 * Just a generic callback, since callbacks are required now.
 */
var dblog = function(db) {
  // Just empty for now. Could be logging like the following:
  // console.log(db);
};


/**
 * Connect to database and make connection available as global var rdb.
 *
 * Also set up tables if needed.
 */
r.connect({host:'localhost', port:28015}, function(err, conn) {
  if (err) {
    throw err;
  }
  // Create the db if we don't have it (will not overwrite).
  r.dbCreate('chat').run(conn, dblog);
  // Set to use imdb as database.
  conn.use('chat');
  // rdb is now global connection.
  rdb = conn;
  // Set up all databases needed.
  for (var i in tables) {
    r.db('chat').tableCreate(i, {primaryKey: tables[i]}).run(conn, dblog);
  }
});

/**
 * Function to write to database.
 *
 * @param str table
 *   The table to write information to.
 * @param obj obj
 *   The object to insert.
 */
var writedb = function(table, obj, callback) {
   try {
    r.table(table).insert(obj).run(rdb, dblog);
   } catch(err) {
    // The database connection is most likely down.
    rdb.reconnect();
    // @todo: What a super error handling, let's just try again.
    writedb(table, obj);
  }
}

function findById(id, fn) {
  r.table('users').get(id).run(rdb, fn);
}

function findByMail(mail, fn) {
  r.table('users').filter({'mail': mail}).limit(1).run(rdb, function(err, userdata) {
    userdata.next()
    .then(function(user) {
      if (user && user.mail === mail) {
        return fn(null, user);
      }
      return fn(null, null);
    });
  });
}

passport.use(new local(
  function(username, password, done) {
    // asynchronous verification, for effect...
    process.nextTick(function () {

      // Find the user by username.  If there is no user with the given
      // username, or the password is not correct, set the user to `false` to
      // indicate failure and set a flash message.  Otherwise, return the
      // authenticated `user`.
      findByMail(username, function(err, user) {
        if (err) { return done(err); }
        if (!user) { return done(null, false, { message: 'Unknown user ' + username }); }
        if (!bcrypt.compareSync(password, user.password)) {
          return done(null, false, { message: 'Invalid password' });
        }
        return done(null, user);
      })
    });
  }
));
passport.serializeUser(function(user, done) {
  done(null, user.id);
});

passport.deserializeUser(function(id, done) {
  findById(id, function (err, user) {
    done(err, user);
  });
});

/**
 * @todo Use routes. Just too lazy for now.
 */
app.post('/login',
  passport.authenticate('local', { failureRedirect: '/login', failureFlash: true }),
  function(req, res) {
    res.redirect('/chat');
  }
);

app.get('/logout', function(req, res){
  req.logout();
  res.redirect('/');
});

app.get('/', function (req, res) {
  if (typeof req.user == 'undefined') {
    req.user = false;
  }
  res.render('index', { title: 'Chat 2K', user: req.user });
});

app.get('/login', function (req, res) {
  if (typeof req.user !== 'undefined') {
    // User is logged in.
    res.redirect('/chat');
  }
  else {
    req.user = false;
  }
  var message = req.flash('error');
  if (message.length < 1) {
    message = false;
  }
  res.render('login', { title: 'Login', message: message, user: req.user });
});

app.get('/account', ensureAuthenticated, function(req, res) {
  res.render('account', { user: req.user, title: 'My account' });
});

app.get('/register', function(req, res){
  if (typeof req.user !== 'undefined') {
    // User is logged in.
    res.redirect('/account');
  }
  else {
    req.user = false;
  }
  var message = req.flash('error');
  if (message.length < 1) {
    message = false;
  }
  res.render('register', { title: 'Register', message: message, user: req.user });
});

app.post('/register', function(req, res){
  if (typeof req.user !== 'undefined') {
    // User is logged in.
    res.redirect('/account');
  }
  if (!validateEmail(req.param('email'))) {
    // Probably not a good email address.
    req.flash('error', 'Not a valid email address!')
    res.redirect('/register');
    return;
  }
  if (req.param('password') !== req.param('password2')) {
    // 2 different passwords!
    req.flash('error', 'Passwords does not match!')
    res.redirect('/register');
    return;
  }
  var hash = bcrypt.hashSync(req.param('password'), 8);
  var user = {
    username: req.param('username'),
    mail: req.param('email'),
    password: hash
  }
  writedb('users', user);
  // @todo: Log user in automatically!
  res.redirect('/chat');
});

app.get('/chat', ensureAuthenticated, function(req, res){
  res.render('chat', { user: req.user, title: 'Chat' });
});

app.get('/user/:uid', ensureAuthenticated, function(req, res){
  var uid = req.params.uid;
  findById(uid, function(placeholder, userobj) {
    res.render('user', { seeUser: userobj, title: userobj.username, user: req.user });
  });
});

var usersonline = {};
io.sockets.on('connection', function (socket) {
  r.table('messages').orderBy(r.desc('timestamp')).limit(100).run(rdb, function(err, cur) {
    cur.toArray()
    .then(function(messages) {
      socket.emit('history', messages);
    });
  });
  var user;
  var i = setInterval(function() {
    socket.emit('whoshere', { 'users': usersonline });
  }, 3000);
  socket.on('iamhere', function(data) {
    // This is sent by users when they connect, so we can map them to a user.
    findById(data, function(placeholder, userobj) {
      user = userobj;
      usersonline[user.id] = {
        'id': data,
        'name': user.username
      };
    });
  });
  socket.on('message', function (data) {
    var message = {
      message: data.message,
      from: user.username,
      timestamp: new Date().getTime()
    };
    socket.emit('new message', message);
    // Save message.
    writedb('messages', message);
    // Send message to everyone.
    socket.broadcast.emit('new message', message);
  });
  socket.on('disconnect', function() {
    delete usersonline[user.id];
  });
});

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) { return next(); }
  res.redirect('/login')
}

function validateEmail(email) {
  var re = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(email);
}
server.listen(8000);
