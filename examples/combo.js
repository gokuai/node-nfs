// Copyright 2014 Joyent, Inc.  All rights reserved.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var libuuid = require('node-uuid');
var nfs = require('../lib');
var rpc = require('oncrpc');
var statvfs = require('statvfs');
var vasync = require('vasync');

var sattr3 = require('../lib/nfs/sattr3');
var fattr3 = require('../lib/nfs/fattr3');
var create_call = require('../lib/nfs/create_call');
var write_call = require('../lib/nfs/write_call');
var murmur = require('./murmur3');

///--- Globals

var FILE_HANDLES = {};
var MOUNTS = {};


////--- Private Functions
/**
 * 认证,但是现在没在用
 * @param req
 * @param res
 * @param next
 */
function authorize(req, res, next) {
    // Let everything through
    // if (!req.is_user(0)) {
    //     res.status = nfs.NFS3ERR_ACCES;
    //     res.send();
    //     next(false);
    // } else {
    //     next();
    // }
    next();
}

/**
 * 检查目录路径
 * @param req
 * @param res
 * @param next
 */
function check_dirpath(req, res, next) {
    assert.string(req.dirpath, 'req.dirpath');

    var p = path.normalize(req.dirpath);
    req._dirpath = p;
    if (p.length > 64) {
        res.error(nfs.NFS3ERR_NAMETOOLONG);
        next(false);
        return;
    }

    fs.stat(p, function (err, stats) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else if (!stats.isDirectory()) {
            res.error(nfs.NFS3ERR_NOTDIR);
            next(false);
        } else {
            next();
        }
    });
}

/**
 * 挂载磁盘
 * @param req
 * @param res
 * @param next
 */
function mount(req, res, next) {
    var uuid = libuuid.v4();
    MOUNTS[uuid] = req._dirpath;
    FILE_HANDLES[uuid] = req._dirpath;
    res.setFileHandle(uuid);
    res.send();
    next();
}

/**
 * 挂载磁盘
 * @param req
 * @param res
 * @param next
 */
function umount(req, res, next) {
    res.send();
    next();
}

/**
 * 检查FILE_HANDLES表
 * @param req
 * @param res
 * @param next
 */
function check_fh_table(req, res, next) {
    if (!FILE_HANDLES[req.object]) {
        req.log.warn({
            call: req.toString(),
            object: req.object
        }, 'check_fh_table: object not found');
        res.error(nfs.NFS3ERR_STALE);
        next(false);
    } else {
        next();
    }
}

/**
 * Get file attributes
 * @param req
 * @param res
 * @param next
 */
function get_attr(req, res, next) {
    var f = FILE_HANDLES[req.object]
    fs.lstat(f, function (err, stats) {
        if (err) {
            req.log.warn(err, 'get_attr: lstat failed');
            res.error(nfs.NFS3ERR_STALE);
            next(false);
        } else {
            res.setAttributes(stats);
            res.send();
            next();
        }
    });
}

/**
 * Set file attributes
 * @param req
 * @param res
 * @param next
 */
function set_attr(req, res, next) {
    var f = FILE_HANDLES[req.object]

    // To support the weak cache consistency data return object we must be
    // able to atomically stat the file before we set the attributes, make
    // the changes, then stat the file again once we're done. For now we'll
    // simply return that there is no wcc_data (which is allowed by the spec).

    // stat first so we can pass back params that were not provided (e.g.
    // if only have uid/gid, need the other one).
    var stats;
    try {
        stats = fs.lstatSync(f);
    } catch (e) {
        req.log.warn(e, 'set_attr: lstat failed');
        res.error(nfs.NFS3ERR_STALE);
        next(false);
        return;
    }

    // XXX translate errors into better return code below

    if (req.new_attributes.mode !== null) {
        try {
            fs.chmodSync(f, req.new_attributes.mode);
        } catch (e) {
            req.log.warn(e, 'set_attr: chmod failed');
            res.error(nfs.NFS3ERR_STALE);
            next(false);
            return;
        }
    }

    var uid;
    var gid;

    if (req.new_attributes.uid !== null)
        uid = req.new_attributes.uid;
    else
        uid = stats.uid;

    if (req.new_attributes.gid !== null)
        gid = req.new_attributes.gid;
    else
        gid = stats.gid;

    if (req.new_attributes.uid !== null || req.new_attributes.gid !== null) {
        try {
            fs.chownSync(f, uid, gid);
        } catch (e) {
            req.log.warn(e, 'set_attr: chown failed');
            res.error(nfs.NFS3ERR_STALE);
            next(false);
            return;
        }
    }

    var atime;
    var mtime;

    if (req.new_attributes.how_a_time === sattr3.time_how.SET_TO_CLIENT_TIME) {
        msecs = (req.new_attributes.atime.seconds * 1000) +
            (req.new_attributes.atime.nseconds / 1000000);
        atime = new Date(msecs);
    } else {
        atime = stats.atime;
    }

    if (req.new_attributes.how_m_time === sattr3.time_how.SET_TO_CLIENT_TIME) {
        msecs = (req.new_attributes.mtime.seconds * 1000) +
            (req.new_attributes.mtime.nseconds / 1000000);
        mtime = new Date(msecs);
    } else {
        mtime = stats.mtime;
    }

    if (req.new_attributes.how_a_time === sattr3.time_how.SET_TO_CLIENT_TIME ||
        req.new_attributes.how_m_time === sattr3.time_how.SET_TO_CLIENT_TIME) {
        try {
            fs.utimesSync(f, atime, mtime);
        } catch (e) {
            req.log.warn(e, 'set_attr: utimes failed');
            res.error(nfs.NFS3ERR_STALE);
            next(false);
            return;
        }
    }

    res.send();
    next();
}

/**
 * Check Access Permission
 * @param req
 * @param res
 * @param next
 */
function fs_set_attrs(req, res, next) {
    var f = FILE_HANDLES[req.object];
    fs.lstat(f, function (err, stats) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else {
            req._stats = stats;
            res.setAttributes(stats);
            next();
        }
    });
}

/**
 * Get static file system Information
 * @param req
 * @param res
 * @param next
 */
function fs_info(req, res, next) {
    var stats = req._stats;
    // Stolen from: http://goo.gl/fBLulQ (IBM)
    res.wtmax = res.rtmax = 65536;
    res.wtpref = res.rtpref = 32768;
    res.wtmult = res.rtmult = 4096;
    res.dtpref = 8192;

    // Our made up vals
    res.maxfilesize = 1099511627776; // 1T
    res.time_delta = {
        seconds: 0,
        nseconds: 1000000
    }; // milliseconds

    // TODO: this isn't right, for some reason...
    res.properties =
        nfs.FSF3_LINK |
        nfs.FSF3_SYMLINK;

    res.send();
    next();
}

/**
 * Get dynamic file system information
 * @param req
 * @param res
 * @param next
 */
function fs_stat(req, res, next) {
    var f = FILE_HANDLES[req.object];
    statvfs(f, function (err, stats) {
        if (err) {
            req.log.warn(err, 'fs_stat: statvfs failed');
            res.error(nfs.NFS3ERR_STALE);
            next(false);
        } else {
            //req.log.debug('fs_stat', stats);
            /*
             修改文件大小显示的bug
             */
            res.tbytes = stats.blocks * stats.frsize;
            res.fbytes = stats.bfree * stats.frsize;
            res.abytes = stats.bavail * stats.frsize;
            res.tfiles = stats.files;
            res.ffiles = stats.ffree;
            res.afiles = stats.favail;
            res.invarsec = 0;
            res.send();
            next();
        }
    });
}

/**
 * Retrieve POSIX information
 * @param req
 * @param res
 * @param next
 */
function path_conf(req, res, next) {
    // var f = FILE_HANDLES[req.object];
    // TODO: call pathconf(2)
    res.linkmax = 32767;
    res.name_max = 255;
    res.no_trunc = true;
    res.chown_restricted = true;
    res.case_insensitive = false;
    res.case_preserving = true;
    res.send();
    next();
}

/**
 * Access Permission
 * @param req
 * @param res
 * @param next
 */
function access(req, res, next) {
    res.access =
        nfs.ACCESS3_READ |
        nfs.ACCESS3_LOOKUP |
        nfs.ACCESS3_MODIFY |
        nfs.ACCESS3_EXTEND |
        nfs.ACCESS3_DELETE |
        nfs.ACCESS3_EXECUTE;
    res.send();
    next();
}

/**
 * Lookup filename
 * @param req
 * @param res
 * @param next
 */
function lookup(req, res, next) {
    var dir = FILE_HANDLES[req.what.dir];

    fs.lstat(dir, function (err, stats) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else {
            res.setDirAttributes(stats);

            var f = path.resolve(dir, req.what.name);
            fs.lstat(f, function (err2, stats2) {
                if (err2) {
                    nfs.handle_error(err2, req, res, next);
                } else {
                    var uuid = libuuid.v4();
                    FILE_HANDLES[uuid] = f;

                    res.object = uuid;
                    res.setAttributes(stats2);

                    res.send();
                    next();
                }
            });
        }
    });
}

/**
 * Create a file
 * @param req
 * @param res
 * @param next
 */
function create(req, res, next) {

    // fail exclusive create
    if (req.how === create_call.create_how.EXCLUSIVE) {
        req.log.warn(e, 'create: exclusive allowed');
        res.error(nfs.NFS3ERR_NOTSUPP);
        next(false);
        return;
    }

    var dir = FILE_HANDLES[req.where.dir];
    var nm = path.join(dir, req.where.name);

    var flags;

    if (req.how === create_call.create_how.UNCHECKED) {
        flags = 'w';
    } else if (req.how === create_call.create_how.GUARDED) {
        flags = 'wx';
    }

    var mode = parseInt('0644', 8);
    if (req.obj_attributes.mode !== null)
        mode = req.obj_attributes.mode;

    fs.open(nm, flags, mode, function (err, fd) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else {
            fs.closeSync(fd);

            var uuid = libuuid.v4();
            FILE_HANDLES[uuid] = nm;

            res.obj = uuid;

            var uid;
            var gid;

            if (req.obj_attributes.uid === null ||
                req.obj_attributes.gid === null) {
                try {
                    var stats = fs.lstatSync(dir);
                    uid = stats.uid;
                    gid = stats.gid;
                } catch (e) {
                    req.log.warn(e, 'create: lstat failed');
                }
            }

            if (req.obj_attributes.uid !== null)
                uid = req.obj_attributes.uid;

            if (req.obj_attributes.gid !== null)
                gid = req.obj_attributes.gid;

            try {
                fs.chownSync(nm, uid, gid);
            } catch (e) {
                req.log.warn(e, 'create: chown failed');
            }

            try {
                var stats = fs.lstatSync(nm);
                res.setObjAttributes(stats);
            } catch (e) {
                req.log.warn(e, 'create: lstat failed');
            }

            res.send();
            next();
        }
    });
}

/**
 * Create a special device
 * @param req
 * @param res
 * @param next
 */
function mknod(req, res, next) {
    res.error(nfs.NFS3ERR_NOTSUPP);
    next(false);
}

/**
 * Create a directory
 * @param req
 * @param res
 * @param next
 */
function mkdir(req, res, next) {
    if (req.where.name === "." || req.where.name === "..") {
        req.log.warn(e, 'mkdir: dot or dotdot not allowed');
        res.error(nfs.NFS3ERR_EXIST);
        next(false);
        return;
    }

    var dir = FILE_HANDLES[req.where.dir];

    fs.stat(dir, function (err, stats) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else if (!stats.isDirectory()) {
            res.error(nfs.NFS3ERR_NOTDIR);
            next(false);
        } else {

            var nm = path.join(dir, req.where.name);
            var mode;
            if (req.attributes.mode !== null)
                mode = req.attributes.mode;
            else
                mode = parseInt('0755', 8);

            fs.mkdir(nm, mode, function (err2) {
                if (err2) {
                    // ENOENT is not a valid return from this the procedure.
                    // If the dir disappeared, return as from the check above.
                    if (err2.code === 'ENOENT')
                        err2.code = 'ENOTDIR';
                    nfs.handle_error(err2, req, res, next);
                } else {
                    var uuid = libuuid.v4();
                    FILE_HANDLES[uuid] = nm;

                    res.obj = uuid;

                    // If no uid/gid, use the parent's

                    var uid;
                    var gid;

                    if (req.attributes.uid !== null)
                        uid = req.attributes.uid;
                    else
                        uid = stats.uid;

                    if (req.attributes.gid !== null)
                        gid = req.attributes.gid;
                    else
                        gid = stats.gid;

                    try {
                        fs.chownSync(nm, uid, gid);
                    } catch (e) {
                        req.log.warn(e, 'mkdir: chown failed');
                    }

                    var stats2;
                    try {
                        stats2 = fs.lstatSync(nm);
                        res.setObjAttributes(stats2);
                    } catch (e) {
                        req.log.warn(e, 'mkdir: lstat failed');
                    }

                    res.send();
                    next();
                }
            });
        }
    });
}

/**
 * Remove a Directory
 * @param req
 * @param res
 * @param next
 */
function rmdir(req, res, next) {
    if (req._object.name === ".") {
        req.log.warn(e, 'rmdir: dot not allowed');
        res.error(nfs.NFS3ERR_INVAL);
        next(false);
        return;
    }

    if (req._object.name === "..") {
        req.log.warn(e, 'rmdir: dotdot not allowed');
        res.error(nfs.NFS3ERR_EXIST);
        next(false);
        return;
    }

    var dir = FILE_HANDLES[req._object.dir];
    var nm = path.join(dir, req._object.name);

    fs.lstat(nm, function (err, stats) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else if (!stats.isDirectory()) {
            res.error(nfs.NFS3ERR_NOTDIR);
            next(false);
        } else {

            fs.rmdir(nm, function (err2) {
                if (err2) {
                    nfs.handle_error(err2, req, res, next);
                } else {
                    res.send();
                    next();
                }
            });
        }
    });
}

/**
 * Read From Directory
 * @param req
 * @param res
 * @param next
 */
function readdir(req, res, next) {
    var dir = FILE_HANDLES[req.dir];
    fs.readdir(dir, function (err, files) {
        if (err) {
            nfs.handle_error(err, req, res, next);
            return;
        }
        res.eof = (files.length < req.count);
        res.setDirAttributes(req._stats);

        var cook = 1;
        files.forEach(function (f) {
            var p = path.join(dir, f);

            res.addEntry({
                fileid: murmur(p, 1234),
                name: f,
                cookie: cook++
            });
        });
        res.send();
        next();
    });
}

/**
 * Extended read from directory
 * @param req
 * @param res
 * @param next
 */
function readdirplus(req, res, next) {
    var dir = FILE_HANDLES[req.dir];
    fs.readdir(dir, function (err, files) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else {
            res.eof = (files.length < req.dircount) || true;
            res.setDirAttributes(req._stats);

            var barrier = vasync.barrier();
            var error = null;

            barrier.once('drain', function () {
                if (error) {
                    nfs.handle_error(error, req, res, next);
                } else {
                    console.log('res', res.toString());
                    res.send();
                    next();
                }
            });

            files.forEach(function (f) {
                barrier.start('stat::' + f);

                var p = path.join(dir, f);

                fs.lstat(p, function (err2, stat) {
                    barrier.done('stat::' + f);
                    if (err2) {
                        error = error || err2;
                    } else {

                        var handle = null;
                        for (var uuid in FILE_HANDLES) {
                            if (FILE_HANDLES[uuid] === p) {
                                handle = uuid;
                                break;
                            }
                        }

                        if (!handle) {
                            var uuid = libuuid.v4();
                            FILE_HANDLES[uuid] = p;
                            handle = uuid;
                        }

                        res.addEntry({
                            fileid: stat.ino,
                            name: f,
                            cookie: stat.mtime.getTime(),
                            name_attributes: fattr3.create(stat),
                            name_handle: handle
                        });
                    }
                });
            });
        }
    });
}

/**
 * Create Link to an object
 * @param req
 * @param res
 * @param next
 */
function link(req, res, next) {
    var f = FILE_HANDLES[req.file];
    var dir = FILE_HANDLES[req.link.dir];
    var nm = path.join(dir, req.link.name);

    fs.link(f, nm, function (err) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else {
            try {
                var stats = fs.statSync(nm);
                res.setFileAttributes(stats);
            } catch (e) {
                req.log.warn(e, 'link: lstat failed');
            }

            res.send();
            next();
        }
    });
}

/**
 * Read from symbolic link
 * @param req
 * @param res
 * @param next
 */
function readlink(req, res, next) {
    var f = FILE_HANDLES[req.symlink];

    fs.readlink(f, function (err, linkstr) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else {
            res.data = linkstr;

            try {
                var stats = fs.lstatSync(f);
                res.setAttributes(stats);
            } catch (e) {
                req.log.warn(e, 'link: lstat failed');
            }

            res.send();
            next();
        }
    });
}

/**
 * Create a symbolic link
 * @param req
 * @param res
 * @param next
 */
function symlink(req, res, next) {
    var dir = FILE_HANDLES[req.where.dir];
    var slink = path.join(dir, req.where.name);

    fs.symlink(req.symlink_data, slink, function (err) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else {
            var uuid = libuuid.v4();
            FILE_HANDLES[uuid] = slink;

            res.obj = uuid;

            // If no uid/gid, use the parent's
            var uid = 0;
            var gid = 0;

            try {
                var stats = fs.lstatSync(dir);
                uid = stats.uid;
                gid = stats.gid;
            } catch (e) {
                req.log.warn(e, 'symlink: lstat failed');
            }

            if (req.symlink_attributes.uid !== null)
                uid = req.symlink_attributes.uid;

            if (req.symlink_attributes.gid !== null)
                gid = req.symlink_attributes.gid;

            try {
                fs.lchownSync(slink, uid, gid);
            } catch (e) {
                req.log.warn(e, 'symlink: chown failed');
            }

            try {
                var stats = fs.lstatSync(slink);
                res.setObjAttributes(stats);
            } catch (e) {
                req.log.warn(e, 'symlink: lstat failed');
            }

            res.send();
            next();
        }
    });
}

/**
 * Remove a File
 * @param req
 * @param res
 * @param next
 */
function remove(req, res, next) {
    var dir = FILE_HANDLES[req._object.dir];
    var nm = path.join(dir, req._object.name);

    fs.lstat(nm, function (err, stats) {
        if (err) {
            nfs.handle_error(err, req, res, next);
        } else if (stats.isDirectory()) {
            res.error(nfs.NFS3ERR_ACCES);
            next(false);
        } else {

            fs.unlink(nm, function (err2) {
                if (err2) {
                    nfs.handle_error(err2, req, res, next);
                } else {
                    res.send();
                    next();
                }
            });
        }
    });
}

/**
 * Rename a File or Directory
 * @param req
 * @param res
 * @param next
 */
function rename(req, res, next) {
    var fdir = FILE_HANDLES[req.from.dir];
    var fnm = path.join(fdir, req.from.name);

    var tdir = FILE_HANDLES[req.to.dir];
    var tnm = path.join(fdir, req.to.name);

    fs.rename(fnm, tnm, function (err2) {
        if (err2) {
            nfs.handle_error(err2, req, res, next);
        } else {
            res.send();
            next();
        }
    });
}

/**
 * Read From file
 * @param req
 * @param res
 * @param next
 */
function read(req, res, next) {
    var f = FILE_HANDLES[req.file];
    fs.open(f, 'r', function (open_err, fd) {
        if (open_err) {
            nfs.handle_error(open_err, req, res, next);
            return;
        }

        res.data = new Buffer(req.count);
        fs.read(fd, res.data, 0, req.count, req.offset, function (err, n) {
            if (err) {
                fs.closeSync(fd);
                nfs.handle_error(err, req, res, next);
            } else {
                // XXX kludge to set eof
                var eof = false;
                try {
                    var stats = fs.fstatSync(fd);
                    if (stats.size <= (req.offset + req.count))
                        eof = true;
                } catch (e) {
                }

                fs.closeSync(fd);
                res.count = n;
                res.eof = eof;
                res.send();
                next();
            }
        });
    });
}

/**
 * Write to file
 * @param req
 * @param res
 * @param next
 */
function write(req, res, next) {
    var f = FILE_HANDLES[req.file];

    fs.open(f, 'r+', function (open_err, fd) {
        if (open_err) {
            nfs.handle_error(open_err, req, res, next);
            return;
        }

        fs.write(fd, req.data, 0, req.count, req.offset, function (err, n, b) {
            if (err) {
                fs.closeSync(fd);
                nfs.handle_error(err, req, res, next);
            } else {
                // Always sync to avoid double writes, see comment below for
                // res.comitted.
                fs.fsync(fd, function (err2) {
                    // XXX ignore errors on the sync

                    fs.closeSync(fd);
                    res.count = n;

                    // XXX Would like res.committed = req.stable but at least
                    // on MacOS it sends the write with stable == UNSTABLE, but
                    // if we return committed == UNSTABLE, it will resend the
                    // write with stable == FILE_SYNC.
                    res.committed = write_call.stable_how.FILE_SYNC;

                    res.send();
                    next();
                });
            }
        });
    });
}

/**
 * Commit cached data on a server to stable
 * @param req
 * @param res
 * @param next
 */
function commit(req, res, next) {
    var f = FILE_HANDLES[req.file];

    fs.open(f, 'r+', function (open_err, fd) {
        if (open_err) {
            nfs.handle_error(open_err, req, res, next);
            return;
        }

        fs.fsync(fd, function (err) {
            // XXX ignore errors on the sync

            fs.closeSync(fd);

            res.send();
            next();
        });
    });
}


///--- Mainline

(function main() {
    function logger(name) {
        return (bunyan.createLogger({
            name: name,
            level: process.env.LOG_LEVEL || 'debug',
            src: true,
            streams: [{
                type: 'file',
                path: 'nfs.log'
            }],
            serializers: rpc.serializers
        }));
        return (l);
    }

    var portmapd = rpc.createPortmapServer({
        name: 'portmapd',
        log: logger('portmapd')
    });

    var mountd = nfs.createMountServer({
        name: 'mountd',
        log: logger('mountd')
    });

    var nfsd = nfs.createNfsServer({
        name: 'nfsd',
        log: logger('nfsd')
    });

    portmapd.get_port(function get_port(req, res, next) {
        if (req.mapping.prog === 100003) {
            res.port = 2049;
        } else if (req.mapping.prog === 100005) {
            res.port = 1892;
        }

        res.send();
        next();
    });

    mountd.mnt(authorize, check_dirpath, mount);
    mountd.umnt(authorize, check_dirpath, umount);

    nfsd.getattr(authorize, check_fh_table, get_attr);
    nfsd.setattr(authorize, check_fh_table, set_attr);
    nfsd.lookup(authorize, check_fh_table, lookup);
    nfsd.mkdir(authorize, check_fh_table, mkdir);
    nfsd.mknod(authorize, check_fh_table, mknod);
    nfsd.remove(authorize, check_fh_table, remove);
    nfsd.rmdir(authorize, check_fh_table, rmdir);
    nfsd.rename(authorize, check_fh_table, rename);
    nfsd.create(authorize, check_fh_table, create);
    nfsd.access(authorize, check_fh_table, fs_set_attrs, access);
    nfsd.read(authorize, check_fh_table, fs_set_attrs, read);
    nfsd.write(authorize, check_fh_table, write);
    nfsd.readdir(authorize, check_fh_table, fs_set_attrs, readdir);
    nfsd.readdirplus(authorize, check_fh_table, fs_set_attrs, readdirplus);
    nfsd.link(authorize, check_fh_table, link);
    nfsd.readlink(authorize, check_fh_table, readlink);
    nfsd.symlink(authorize, check_fh_table, symlink);
    nfsd.fsstat(authorize, check_fh_table, fs_set_attrs, fs_stat);
    nfsd.fsinfo(authorize, check_fh_table, fs_set_attrs, fs_info);
    nfsd.pathconf(authorize, check_fh_table, fs_set_attrs, path_conf);
    nfsd.commit(authorize, check_fh_table, commit);

    var log = logger('audit');

    function after(name, req, res, err) {
        log.info({
            call: req.toString(),
            reply: res.toString(),
            err: err
        }, '%s: handled', name);
    }

    portmapd.on('after', after);
    mountd.on('after', after);
    nfsd.on('after', after);

    nfsd.on('uncaughtException', function (req, res, err) {
        console.error('ERROR: %s', err.stack);
        process.exit(1);
    });

    mountd.on('uncaughtException', function (req, res, err) {
        console.error('ERROR: %s', err.stack);
        process.exit(1);
    });

    portmapd.start(function () {
        mountd.start(function () {
            nfsd.start(function () {
                console.log('ready');
            });
        });
    })
})();
