"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStatus = void 0;
/**
 * Enum for possible session statuses
 */
var SessionStatus;
(function (SessionStatus) {
    SessionStatus["KEYGEN"] = "keygen";
    SessionStatus["SIGNING"] = "signing";
    SessionStatus["COMPLETED"] = "completed";
    SessionStatus["EXPIRED"] = "expired";
})(SessionStatus || (exports.SessionStatus = SessionStatus = {}));
