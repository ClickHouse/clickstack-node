"use strict";

// Node as PID 1 in a container ignores a signal it sends itself; a no-op kill simulates that.
process.kill = () => true;
