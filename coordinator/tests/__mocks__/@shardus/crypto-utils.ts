// Manual mock for @shardus/crypto-utils

export const init = jest.fn();
export const verifyObj = jest.fn();
export const signObj = jest.fn(); // The actual function used for signing objects
export const sign = jest.fn(); // Low-level signing
export const hash = jest.fn();
export const hashObj = jest.fn();
export const setCustomStringifier = jest.fn();
export const setHashKey = jest.fn();
export const generateKeypair = jest.fn();

export default {
  init,
  verifyObj,
  signObj,
  sign,
  hash,
  hashObj,
  setCustomStringifier,
  setHashKey,
  generateKeypair,
};
