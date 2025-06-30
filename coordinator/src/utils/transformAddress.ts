export const isEthereumAddress = (address: string): boolean => {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

export const isShardusAddress = (address: string): boolean => {
  if (address.length !== 64) return false
  return true
}

export const toShardusAddress = (address: string): string => {
  if (address.length === 64) return address
  if (isEthereumAddress(address)) {
    address = address.slice(2).toLowerCase()
    return address + '0'.repeat(24)
  }
  return address // return original address even if it's not a valid address
}

export const toEthereumAddress = (address: string): string => {
  if (isEthereumAddress(address)) return address
  if (isShardusAddress(address)) {
    // Check if the last 24 characters are 0s
    if (address.endsWith('0'.repeat(24))) {
      address = address.slice(0, -24).toLowerCase()
      return '0x' + address
    }
  }
  return address // return original address even if it's not a valid address
}
