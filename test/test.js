///**
// * Created by Meteor on 16/1/6.
// */
//var statvfs = require('statvfs');
//
//statvfs('/Users/Meteor/Documents', function (err, stats) {
//    //assert.ifError(err); // on errno, will be a node ErrnoException
//    console.log(JSON.stringify(stats, null, 2));
//    /*
//     {
//     "bsize": 4096,
//     "frsize": 4096,
//     "blocks": 262144,
//     "bfree": 252508,
//     "bavail": 252508,
//     "files": 292304,
//     "ffree": 289126,
//     "favail": 289126,
//     "fsid": 140509193,
//     "basetype": "tmpfs",
//     "flag": 4,
//     "namemax": 255,
//     "fstr": "/tmp"
//     }
//     */
//});
//
//var disk = require('diskusage');
//
//// get disk usage. Takes mount point as first parameter
//disk.check('/Users/Meteor/Documents', function (err, info) {
//    console.log('available', info.available);
//    console.log('free', info.free);
//    console.log('total', info.total);
//});
var fs = require('fs-extra');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var libuuid = require('node-uuid');
var nfs = require('../lib');
var rpc = require('oncrpc');
var statvfs = require('statvfs');
var vasync = require('vasync');
var ALY = require('aliyun-sdk');
var request = require('request');

var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('../nfs.db');
//
//db.run("INSERT INTO File (file, status) VALUES (?, ?)", '/Users/Meteor', 200);
//db.get('SELECT status FROM File WHERE file = ?', '/Users/Meteor', function (err, row) {
//    console.log(row);
//});
//
//db.serialize(function () {
//    db.run("CREATE TABLE if not exists File (file TEXT UNIQUE, status TEXT, url TEXT)");
//    //db.run("INSERT INTO File (file, status) VALUES (?, ?)", '/Users/Meteor', 200, function(err) {
//    //    if (err) {
//    //        console.log(err);
//    //    }
//    //});
//    db.get('SELECT * FROM File WHERE file = ?', '/Users/Meteor', function (err, row) {
//        console.log(err, row);
//    });
//});

//var async = require('async');
//var count = 0;
//
//async.whilst(
//    function () {
//        return count < 5;
//    },
//    function (callback) {
//        count++;
//        //setTimeout(function () {
//        //    callback(null, count);
//        //}, 1000);
//        callback(count, count);
//    },
//    function (err, n) {
//        console.log(err, n);
//        // 5 seconds have passed, n = 5
//    }
//);
var libuuid = require('node-uuid');
console.log(libuuid.v4());