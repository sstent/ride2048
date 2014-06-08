// привет
(function (ns) {
    var _extend = function (doOverwrite, target) {
        if (target && (typeof target == 'object' || typeof target == 'function')) {
            for (var i = 2, l = arguments.length, obj; i < l; ++i) {
                obj = arguments[i];

                for (var props in obj) {
                    if ((target[props] === undefined || doOverwrite) && obj[props] !== undefined) {
                        target[props] = obj[props];
                    }
                }
            }
        }
        
        return target;
    };
    var extend = ns.extend = function () {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(true);
        return _extend.apply(this, args);
    };
    var extendIf = ns.extend = function () {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(false);
        return _extend.apply(this, args);
    };

    var App = ns.App = function (opts) {
        this.defaults = extend({}, App.prototype.defaults, opts ? opts.defaults : null);
        if (opts.defaults) {
            delete opts.defaults;
        }
        extend(this, opts);
        this.init();
    };
    App.prototype = {
        constructor: App,
        cellSize: 70, // Cell size in pixels
        cellMargin: 10,
        rows: 5,
        height: 620,
        maxFPS: 60,
        inputManagers: null,
        renderer: null,
        scoreManager: null,
        dataManager: null,
        defaults: {
            speed: 150, // Cells fall speed in pixels per second
            spawnRate: 3 // One spawn per N seconds
        },
        speedInc: 1.01, // Percents to add to speed after each collision
        spawnRateInc: 0.99, // Percents to add to spawn rate after each collision
        maxSpeed: 2000, // Max fall speed
        maxSpawnRate: 0.3, // Max spawn rate
        maxSpawnValue: 128, // Max cell value that can be spawned
        consumeDuration: 0.2, // Speed of consuming one cell by another in seconds
        rowChangeDuration: 0.2, // Speed of row movement in seconds

        states: {
            falling: 'falling',
            grounded: 'grounded',
            consumed: 'consumed',
            removed: 'removed',
            looseReason: 'loose'
        },
        commands: {
            moveLeft: 'moveLeft',
            moveRight: 'moveRight',
            pause: 'pause'
        },

        init: function () {
            extend(this, this.defaults, {
                isPaused: true,
                isOver: true
            });

            if (this.inputManagers) {
                for (var i = 0, l = this.inputManagers.length; i < l; ++i) {
                    this.inputManagers[i].init();
                }
            }
            this.disableInputs();

            if (this.renderer) {
                this.renderer.init();
            }

            if (this.scoreManager) {
                this.scoreManager.init();
            }

            if (this.dataManager) {
                this.dataManager.init();
            }

            this.objs = []; 
            this.grid = []; // grounded
            this.vals = [2, 4];
            this.rowsOccupied = {};

            this.timeFromLastSpawn = 0;
        },
        destroy: function () {
            if (this.inputManagers) {
                for (var i = 0, l = this.inputManagers.length; i < l; ++i) {
                    this.inputManagers[i].destroy();
                }
            }

            if (this.renderer) {
                this.renderer.destroy();
            }

            if (this.scoreManager) {
                this.scoreManager.destroy();
            }

            if (this.dataManager) {
                this.dataManager.destroy();
            }

            delete this._lastCmdTTL;

            delete this.objs;
            delete this.grid;
        },
        getGridY: function (worldY) {
            return Math.floor((this.height - worldY) / (this.cellSize + this.cellMargin));
        },
        getWorldY: function (gridY) {
            return this.height - gridY * (this.cellSize + this.cellMargin) - this.cellSize;
        },
        requestAnimationFrame: (function () {
            var fn = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame;
            var T = this;
            if (fn) {
                return function (callback) {
                    return fn(callback);
                }
            } else {
                return function (callback) {
                    return setTimeout(callback, 1000 / T.maxFPS);
                }
            }
        })(),
        cancelAnimationFrame: (function () {
            var fn = window.cancelAnimationFrame || window.mozCancelAnimationFrame || window.webkitCancelAnimationFrame || window.msCancelAnimationFrame;
            if (fn) {
                return function (id) {
                    return fn(id);
                }
            } else {
                return function (id) {
                    return clearTimeout(id);
                }
            }
            return fn;
        })(),
        resume: function () {
            if (this.isPaused && !this.isOver) {
                this.isPaused = false;

                var time = (new Date()).getTime(),
                    T = this;
                function update() {
                    if (!T.isPaused) {
                        var newTime = (new Date()).getTime(),
                            dt = (newTime - time) / 1000;
                            T.update(dt);
                            time = newTime;
                        T._requestAnimationFrameId = T.requestAnimationFrame(update);
                    }
                };

                this._requestAnimationFrameId = this.requestAnimationFrame(update);

                this.syncSave();

                this.enableInputs();
            }
        },
        pause: function () {
            if (!this.isPaused) {
                this.isPaused = true;
                this.cancelAnimationFrame(this._requestAnimationFrameId);
                
                this.syncSave();

                this.disableInputs();
            }
        },
        enableInputs: function () {
            if (this.inputManagers) {
                for (var i = 0, l = this.inputManagers.length; i < l; ++i) {
                    this.inputManagers[i].enable();
                }
            }
        },
        disableInputs: function () {
            if (this.inputManagers) {
                for (var i = 0, l = this.inputManagers.length; i < l; ++i) {
                    this.inputManagers[i].disable();
                }
            }
        },
        update: function (dt) {
            this._needSave = false;

            var cmd;
            if (this._lastCmdTTL && this._lastCmdTTL > 0) {
                this._lastCmdTTL -= dt;
            } else {
                // handle grid collisions
                this.handleChainedCollisions();
                // handle grid falls
                this.handleGroundedFalls();

                if (this.inputManagers) {
                    for (var i = 0, l = this.inputManagers.length; !cmd && (i < l); ++i) {
                        cmd = this.inputManagers[i].getCommand();
                    }
                }
            }

            if (cmd) {
                this._lastCmdTTL = this.rowChangeDuration;
            }

            for (var i = 0, l = this.objs.length, obj; i < l; ++i) {
                obj = this.objs[i];
                switch (obj.state) {
                    case this.states.falling:
                        // object wants to fall down
                        this.updateFalling(obj, dt);
                        break;
                    case this.states.grounded:
                        // object wants to obey command
                        this.updateInput(obj, cmd, dt);
                        break;
                    case this.states.consumed:
                        // object wants to wait until it's consumed
                        this.updateConsumed(obj, dt);
                        break;
                    case this.states.removed:
                        // object wants to be removed
                        this.removeObject(i);
                        --i;
                        --l;
                        break;
                }
            }
            // handle collisions of grib objects with all objects
            this.handleCollisions(cmd);
            // move objects after collisions
            this.updatePhysics();
            // spawn new object if needed
            this.updateSpawn(dt);
            // check for gameover condition
            this.handleGameOver();
            // update visual representation of objects
            this.render();

            if (this._needSave) {
                this.syncSave();
            }
        },
        updateInput: function (obj, cmd, dt) {
            if (cmd) {
                var dRow = 0;
                switch (cmd) {
                    case this.commands.moveLeft:
                        dRow = -1;
                        break;
                    case this.commands.moveRight:
                        dRow = 1;
                        break;
                    case this.commands.pause:
                        this.pause();
                        break;
                }
                if (dRow) {
                    obj._row = obj.row + dRow;

                    if (obj._row < 0) {
                        obj._row = 0;
                    }
                    if (obj._row >= this.rows) {
                        obj._row = this.rows - 1;
                    }
                }
            }
        },
        updateFalling: function (obj, dt) {
            obj._y = obj.y + this.speed * dt;
            if (obj._y >= this.height - this.cellSize) {
                obj.y = obj._y = this.height - this.cellSize;
                this.setState(obj, this.states.grounded);
            }
            if (this.rowsOccupied[obj.row] == obj && obj._y >= 0) {
                this.rowsOccupied[obj.row] = null;
            }
        },
        updateConsumed: function (obj, dt) {
            if (!obj._consumeTTL || (obj._consumeTTL -= dt) <= 0) {
                this.setState(obj, this.states.removed);
                if (obj.consumer) {
                    delete obj.consumer.consuming;
                    delete obj.consumer;
                }
            } else {
                obj.row = obj.consumer.row;
                obj.y = obj.consumer.y;
            }
        },
        handleCollisions: function (lastCmd) {
            switch (lastCmd) {
                case this.commands.moveRight:
                    for (var i = this.rows - 1; i >= 0; --i) {
                        this._handleGridRow(i);
                    }
                    break;
                case this.commands.moveLeft:
                default:
                    for (var i = 0; i < this.rows; ++i) {
                        this._handleGridRow(i);
                    }
            }
        },
        _handleGridRow: function (row) {
            for (var i = 0, l = this.grid.length, obj; i < l; ++i) {
                if (!this.grid[i]) continue;

                obj = this.grid[i][row];
                if (obj && obj.state == this.states.grounded) {
                    
                    for (var ii = 0, ll = this.objs.length, obj2; ii < ll; ++ii) {
                        obj2 = this.objs[ii];

                        if (obj == obj2) continue;

                        if (obj2.state != this.states.falling && obj.state != this.states.grounded) continue;

                        var dY = Math.abs(obj._y - obj2._y);
                        if (obj._row == obj2._row &&
                            dY <= this.cellSize) {
                            if (obj.val == obj2.val && (dY <= this.cellMargin || obj.row == obj._row)) {
                                switch (obj2.state) {
                                    case this.states.falling:
                                        this.consume(obj, obj2);
                                        break;
                                    case this.states.grounded:
                                        if (obj2.row != obj2._row) {
                                            this.consume(obj, obj2);
                                        } else if (obj.row != obj._row) {
                                            this.consume(obj2, obj);
                                        }
                                        break;
                                }
                            } else {
                                switch (obj2.state) {
                                    case this.states.falling:
                                        if (obj.row == obj._row) {
                                            obj2.y = obj2._y = obj._y - this.cellSize - this.cellMargin;
                                            this.setState(obj2, this.states.grounded);
                                        } else {
                                            obj._row = obj.row;
                                        }
                                        break;
                                    case this.states.grounded:
                                        if (obj2.row != obj2._row) {
                                            obj2._row = obj2.row;
                                        } else if (obj.row != obj._row) {
                                            obj._row = obj.row;
                                        }
                                        break;
                                }
                            }
                            
                        }
                    }
                }
            }
        },
        updatePhysics: function () {
            for (var i = 0, l = this.objs.length, obj, needGridRefresh; i < l; ++i) {
                obj = this.objs[i];

                if (obj.state == this.states.falling || obj.state == this.states.grounded) {
                    needGridRefresh = obj.state == this.states.grounded && obj.row != obj._row;

                    if (needGridRefresh) {
                        this.removeFromGrid(obj);
                    }

                    obj.row = obj._row;
                    obj.y = obj._y;

                    if (needGridRefresh) {
                        this.addToGrid(obj);
                    }
                }
            }
        },
        handleChainedCollisions: function () {
            // we're going until pre-last element because the most top row of objects can't consume anything
            for (var i = 0, il = this.grid.length - 1, line, obj, obj2; i < il; ++i) {
                line = this.grid[i];
                if (line) {
                    for (var j = 0, jl = line.length; j < jl; ++j) {
                        obj = line[j];
                        if (obj && obj.state == this.states.grounded && !obj.consuming) {
                            obj2 = this.grid[i+1][j];

                            if (obj2 && obj2.state == this.states.grounded && !obj2.consuming && obj.val == obj2.val) {
                                this.consume(obj, obj2);
                            }
                        }
                    }
                }
            }
        },
        handleGroundedFalls: function () {
            for (var row = 0, obj; row < this.rows; ++row) {
                // we're going from second element because lowest objects can't fall
                for (var gridY = 1, gridL = this.grid.length; gridY < gridL; ++gridY) {
                    obj = this.grid[gridY][row];
                    if (obj && obj.state == this.states.grounded && !obj.consuming) {
                        var gridYTo = gridY;
                        for (var gridY2 = gridY - 1; gridY2 >= 0; ++gridY2) {
                            if (this.grid[gridY2][row] && this.grid[gridY2][row].state == this.states.grounded) {
                                break;
                            } else {
                                gridYTo = gridY2;
                            }
                        }
                        if (gridYTo != gridY) {
                            // Let's figure out if some free-falling objects are on our way.
                            // If there are some, make them grounded and increment destination Y for original object.
                            // NOTICE: we can just iterate through objects array, because the older the object the lower it's position on screen
                            // and the lower it's index in objects array
                            for (var i = 0, l = this.objs.length, obj2; (gridYTo != gridY) && (i < l); ++i) {
                                obj2 = this.objs[i];

                                if (obj == obj2) continue;
                                if (obj2.state == this.states.falling && obj2.row == obj.row && obj2.y > obj.y) {
                                    obj2.gridY = gridYTo;
                                    obj2.y = obj2._y = this.getWorldY(obj2.gridY);
                                    this.setState(obj2, this.states.grounded);
                                    ++gridYTo;
                                }
                            }

                            if (gridYTo != gridY) {
                                this.removeFromGrid(obj);

                                obj.gridY = gridYTo;
                                obj._y = obj.y = this.getWorldY(obj.gridY);

                                this.addToGrid(obj);
                            }
                        }
                    }
                }
            }
        },
        handleGameOver: function () {
            for (var i = 0, l = this.objs.length, obj; i < l; ++i) {
                obj = this.objs[i];
                
                if (obj.state == this.states.grounded && obj.y <= 0) {
                    obj.state = this.states.looseReason;
                    this.gameOver();
                    break;
                }
            }
        },
        updateSpawn: function (dt) {
            this.timeFromLastSpawn += dt;
            if (this.timeFromLastSpawn >= this.spawnRate) {
                this.timeFromLastSpawn = 0;
                this.spawn();
            }
        },
        createObject: function (row, y, val, state) {
            return {
                y: y,
                _y: y,
                row: row,
                _row: row,
                val: Number(val),
                state: state
            };
        },
        getUID: function () {
            return Number(String(Math.random()).slice(2)).toString(16);
        },
        addObject: function (obj) {
            obj.id = this.getUID();
            if (obj.state == this.states.grounded) {
                this.addToGrid(obj);
            }
            this.objs.push(obj);
            return obj;
        },
        removeObject: function (idx) {
            var obj = this.objs[idx];
            if (obj.state != this.states.falling) {
                this.removeFromGrid(obj);
            }
            this.objs.splice(idx, 1);
        },
        addToGrid: function (obj) {
            Object.defineProperty(obj, 'gridY', {
                value: this.getGridY(obj.y),
                writable: true,
                configurable: true
            });
            if (!this.grid[obj.gridY]) {
                this.grid[obj.gridY] = [];
            }
            this.grid[obj.gridY][obj.row] = obj;
            return obj;
        },
        removeFromGrid: function (obj) {
            if (this.grid[obj.gridY] && this.grid[obj.gridY][obj.row] == obj) {
                delete this.grid[obj.gridY][obj.row];
            }
        },
        initGrid: function (objs) {
            this.grid = [];
            if (objs) {
                for (var i = 0, l = objs.length, obj; i < l; ++i) {
                    obj = this.objs[i];
                    if (obj.state == this.states.grounded) {
                        this.addToGrid(obj);
                    }
                }
            }
        },
        spawn: function () {
            var freeRows = [];

            for (var i = 0; i < this.rows; ++i) {
                if (!this.rowsOccupied[i]) {
                    freeRows.push(i);
                }
            }

            if (freeRows.length) {
                var val = this.vals[Math.floor(Math.random() * this.vals.length)],
                    row = freeRows[Math.floor(Math.random() * freeRows.length)];

                this.rowsOccupied[row] = this.addObject(this.createObject(row, -this.cellSize, val, this.states.falling));

                this._needSave = true;
            }
        },
        consume: function (consumer, obj) {
            if (obj.state == this.states.grounded) {
                this.removeFromGrid(obj);
            }

            consumer.val += obj.val;
            Object.defineProperty(consumer, 'consuming', {
                value: obj,
                configurable: true
            });

            obj.row = obj._row = consumer.row;
            obj.y = obj._y = consumer.y;

            Object.defineProperty(obj, '_consumeTTL', {
                value: this.consumeDuration,
                writable: true,
                configurable: true
            });
            Object.defineProperty(obj, 'consumer', {
                value: consumer,
                configurable: true
            });

            this.setState(obj, this.states.consumed);

            if (consumer.val <= this.maxSpawnValue && this.vals[this.vals.length - 1] < consumer.val) {
                this.vals.push(consumer.val);
            }

            this.speed *= this.speedInc;
            if (this.speed > this.maxSpeed) {
                this.speed = this.maxSpeed;
            }
            this.spawnRate *= this.spawnRateInc;
            if (this.spawnRate < this.maxSpawnRate) {
                this.spawnRate = this.maxSpawnRate;
            }

            if (this.scoreManager) {
                this.scoreManager.score(consumer.val);
            }

            this._needSave = true;
        },
        setState: function (obj, state) {
            if (obj.state != state) {
                var prevState = obj.state;

                obj.state = state;

                if (prevState == this.states.falling && obj.state == this.states.grounded) {
                    this.addToGrid(obj);
                }
                if (obj.state == this.states.grounded) {
                    this._needSave = true;
                }
            }
        },
        render: function () {
            if (this.renderer) {
                this.renderer.render(this.objs);
            }
        },
        gameOver: function () {
            this.pause();
            this.isOver = true;
            this.syncSave();
        },
        gameRestart: function () {
            this.pause();
            this.destroy();
            this.init();
            this.isOver = false;
            this.addObject(this.createObject(Math.floor(this.rows / 2), this.height - this.cellSize, 2, this.states.grounded));
            this.resume();
        },
        serialize: function () {
            var data = {};

            data.objs = this.objs;
            
            if (!this.isOver) {
                data.timeFromLastSpawn = this.timeFromLastSpawn;
                data.spawnRate = this.spawnRate;
                data.speed = this.speed;
            }

            data.isOver = this.isOver;

            if (this.scoreManager) {
                data.scoreManager = this.scoreManager.serialize();
            }

            return data;
        },
        unserialize: function (data) {
            if (data.objs && data.objs.length) {
                this.objs = data.objs;
            }
            this.initGrid(this.objs);
            this.timeFromLastSpawn = data.timeFromLastSpawn || 0;
            this.spawnRate = data.spawnRate || this.spawnRate;
            this.speed = data.speed || this.speed;
            this.isOver = data.isOver;
            if (this.scoreManager && data.scoreManager) {
                this.scoreManager.unserialize(data.scoreManager);
            }
        },
        syncSave: function () {
            if (this.dataManager) {
                this.dataManager.save(this.serialize());
            }
        },
        syncLoad: function () {
            if (this.dataManager) {
                var data = this.dataManager.load();
                if (data) {
                    this.destroy();
                    this.init();
                    this.isOver = false;

                    this.unserialize(data);

                    this.render();
                }
            }
        }
    };

    var Component = ns.Component = function (opts) {
        if (opts !== false) {
            extend(this, opts);
            this.init();
        }
    };
    Component.prototype = {
        constructor: Component,
        init: function () {},
        destroy: function () {},
        serialize: function () {},
        unserialize: function (data) {}
    }

    var InputManager = ns.InputManager = function (opts) {
        Component.call(this, extend({
            enabled: true,
            commands: App.prototype.commands
        }, opts));
    };
    InputManager.prototype = new Component(false);
    extend(InputManager.prototype, {
        constructor: InputManager,
        getCommand: function () {},
        enable: function () {
            this.enabled = true;
        },
        disable: function () {
            this.enabled = false;
        }
    });

    var KeyboardInputManager = ns.KeyboardInputManager = function (opts) {
        InputManager.call(this, opts);
        
        extendIf(this, {
            commandsMapping: {
                37: this.commands.moveLeft,
                39: this.commands.moveRight,
                27: this.commands.pause
            }
        });

        this.keyDownHandler = this.onKeyDown.bind(this);
        this.keyUpHandler = this.onKeyUp.bind(this);
    }
    KeyboardInputManager.prototype = new InputManager(false);
    extend(KeyboardInputManager.prototype, {
        constructor: KeyboardInputManager,
        init: function () {
            InputManager.prototype.init.apply(this, arguments);

            this.handlers = [];
            this.commandPushed = null;
            this.command = null;
            document.addEventListener('keydown', this.keyDownHandler);
            document.addEventListener('keyup', this.keyUpHandler);
        },
        destroy: function () {
            this.handlers = null;
            this.commandPushed = null;
            this.command = null;
            document.removeEventListener('keydown', this.keyDownHandler);
            document.removeEventListener('keyup', this.keyUpHandler);
        },
        getCommand: function () {
            if (!this.enabled) return null;

            var res = this.command;
            this.command = null;
            return res;
        },
        onKeyDown: function (event) {
            if (this.enabled) {
                var cmd = this.commandsMapping[event.which];
                if (cmd && this.commandPushed != cmd) {
                    this.commandPushed = cmd;
                    this.command = cmd;
                }
            }
        },
        onKeyUp: function (event) {
            if (this.enabled) {
                var cmd = this.commandsMapping[event.which];
                if (cmd) {
                    this.commandPushed = null;
                    this.command = null;
                }
            }
        }
    });

    var TouchInputManager = ns.TouchInputManager = function (opts) {
        InputManager.call(this, extend({
            swipeOffset: 5
        }, opts));

        this.touchStartHandler = this.onTouchStart.bind(this);
        this.touchMoveHandler = this.onTouchMove.bind(this);
        this.touchEndHandler = this.onTouchEnd.bind(this);
        this.touchCancelHandler = this.onTouchCancel.bind(this);
    };
    TouchInputManager.prototype = new InputManager(false);
    extend(TouchInputManager.prototype, {
        constructor: TouchInputManager,
        init: function () {
            document.addEventListener('touchstart', this.touchStartHandler);
            document.addEventListener('touchmove', this.touchMoveHandler);
            document.addEventListener('touchend', this.touchEndHandler);
            document.addEventListener('touchcancel', this.touchCancelHandler);
        },
        destroy: function () {
            document.removeEventListener('touchstart', this.touchStartHandler);
            document.removeEventListener('touchmove', this.touchMoveHandler);
            document.removeEventListener('touchend', this.touchEndHandler);
            document.removeEventListener('touchcancel', this.touchCancelHandler);
        },
        getCommand: function () {
            if (!this.enabled) return null;

            var res = this.command;
            this.command = null;
            return res;
        },
        onTouchStart: function (event) {
            if (this.enabled && !this.currentTouch) {
                this.currentTouch = event.changedTouches[0];
            }
        },
        onTouchMove: function (event) {
            if (this.enabled) {
                event.preventDefault();
                if (this.currentTouch) {
                    for (var i = 0, l = event.changedTouches.length, touch; i < l; ++i) {
                        touch = event.changedTouches[i];
                        if (touch.id == this.currentTouch.id) {
                            var delta = touch.clientX - this.currentTouch.clientX;
                            if (Math.abs(delta) > this.swipeOffset) {
                                this.command = this.commands[delta > 0 ? 'moveRight' : 'moveLeft'];
                                this.onTouchEnd(event);
                            }
                            break;
                        }
                    }
                }
            }
        },
        onTouchEnd: function (event) {
            if (this.enabled && this.currentTouch) {
                for (var i = 0, l = event.changedTouches.length; i < l; ++i) {
                    if (event.changedTouches[i].id == this.currentTouch.id) {
                        delete this.currentTouch;
                        break;
                    }
                }
            }
        },
        onTouchCancel: function (event) {
            this.onTouchEnd(event);
        }
    });

    var RandomInputManager = ns.RandomInputManager = function (opts) {
        InputManager.call(this, extend({
            cooldown: 0
        }, opts));
        extendIf(this, {
            commandsArray: [this.commands.moveLeft, this.commands.moveRight]
        });
    };
    RandomInputManager.prototype = new InputManager(false);
    extend(RandomInputManager.prototype, {
        constructor: RandomInputManager,
        init: function () {
            InputManager.prototype.init.apply(this, arguments);
            this.lastCmdTime = null;
        },
        getCommand: function () {
            if (!this.enabled) return null;

            var time = (new Date()).getTime();
            if (!this.lastCmdTime || (time - this.lastCmdTime > this.cooldown)) {
                this.lastCmdTime = time;
                return this.commandsArray[Math.floor(Math.random() * this.commandsArray.length)];
            } else {
                return null;
            }
        }
    });

    var Renderer = ns.Renderer = function (opts) {
        Component.call(this, extend({
            states: App.prototype.states
        }, opts));
    };
    Renderer.prototype = new Component(false);
    extend(Renderer.prototype, {
        constructor: Renderer,
        render: function (objects) {}
    });

    var HTMLRenderer = ns.HTMLRenderer = function (opts) {
        Renderer.call(this, opts);
    };
    HTMLRenderer.prototype = new Renderer(false);
    extend(HTMLRenderer.prototype, {
        constructor: HTMLRenderer,
        init: function () {
            Renderer.prototype.init.apply(this, arguments);
            this.$container = $(this.container);
            this.$objs = this.$container.find('.ride-tiles');
            this.objsHash = {};
        },
        destroy: function () {
            if (this.$objs) {
                this.$objs.empty();
            }
            delete this.$container;
            delete this.$objs;
            delete this.objsHash;
        },
        render: function (objects) {
            if (!objects) return;

            for (var i = 0, l = objects.length, obj, objHash; i < l; ++i) {
                obj = objects[i];
                objHash = this.objsHash[obj.id];

                switch (obj.state) {
                    case this.states.removed:
                        if (objHash) {
                            objHash.$obj.remove();
                            delete objHash.$obj;
                            delete objHash.$objInner;
                            delete this.objsHash[obj.id];
                        }
                        break;
                    default: 
                        if (!objHash) {
                            objHash = this.objsHash[obj.id] = {};
                            objHash.$objInner = $('<div>').addClass('ride-tile-inner');
                            objHash.$obj = $('<div>').append(objHash.$objInner).appendTo(this.$objs);
                        }
                        objHash.$obj
                            .attr('class', 'ride-tile ride-tile-'+obj.val+' ride-tile-' + obj.state + ' ride-tile-pos-' + obj.row + (obj.consuming ? ' ride-tile-consuming' : ''))
                            .css({
                                'transform': 'translate3d(0,0,0) translateY('+obj.y+'px)'
                            })
                            .find('.ride-tile-inner').text(obj.val);
                }
            }
        }
    });

    var ScoreManager = ns.ScoreManager = function (opts) {
        Component.call(this, opts);
    };
    ScoreManager.prototype = new Component(false);
    extend(ScoreManager.prototype, {
        constructor: ScoreManager,
        init: function () {
            if (!this.points) {
                this.points = 0;
            }
            if (!this.best) {
                this.best = 0;
            }
        },
        destroy: function () {
            this.points = 0;
        },
        score: function (points) {
            this.points += points;
            if (!this.best || this.best < this.points) {
                this.best = this.points;
            }
        },
        serialize: function () {
            return {
                points: this.points || 0,
                best: this.best || 0
            };
        },
        unserialize: function (data) {
            this.points = data.points || 0;
            this.best = data.best || 0;
            this.render();
        }
    });

    var HTMLScoreManager = ns.HTMLScoreManager = function (opts) {
        ScoreManager.call(this, extend({
            animationDuration: 600
        }, opts));
    };
    HTMLScoreManager.prototype = new ScoreManager(false);
    extend(HTMLScoreManager.prototype, {
        constructor: HTMLScoreManager,
        init: function () {
            ScoreManager.prototype.init.apply(this, arguments);
            this.$container = $(this.container);
            this.$points = this.$container.find('.ride-score-current .ride-score-value').text(''+this.points);
            this.$best = this.$container.find('.ride-score-best .ride-score-value').text(''+this.best);
        },
        destroy: function () {
            ScoreManager.prototype.destroy.apply(this, arguments);
            delete this.$container;
        },
        score: function (points) {
            this._best = this.best;
            ScoreManager.prototype.score.call(this, points);
            this.render();
            this.showNewPoints(this.$points, points);
        },
        showNewPoints: function ($container, newPoints) {
            var $elem = $('<div>').addClass('ride-score-points-new').text('+'+newPoints).insertAfter($container);
            setTimeout(function () {
                $elem.remove();
            }, this.animationDuration);
        },
        render: function () {
            this.$points.text(this.points);
            this.$best.text(this.best);
        }
    });

    var DataManager = ns.DataManager = function (opts) {
        Component.call(this, opts);
    };
    DataManager.prototype = new Component(false);
    extend(DataManager.prototype, {
        constructor: DataManager,
        save: function (data) {},
        load: function () {},
        clear: function () {}
    });

    var LocalStorageDataManager = ns.LocalStorageDataManager = function (opts) {
        DataManager.call(this, extend({
            supported: !!window.localStorage
        }, opts));
    };
    LocalStorageDataManager.prototype = new DataManager(false);
    extend(LocalStorageDataManager.prototype, {
        constructor: LocalStorageDataManager,
        save: function (data) {
            if (this.supported) {
                var dataStr = JSON.stringify(data);
                localStorage.setItem('_ride2048Data', dataStr);
            }
        },
        load: function () {
            if (this.supported) {
                return JSON.parse(localStorage.getItem('_ride2048Data'));
            }
        },
        clear: function () {
            if (this.supported) {
                localStorage.removeItem('_ride2048Data');
            }
        }
    });
})(window.ride2048 = {});