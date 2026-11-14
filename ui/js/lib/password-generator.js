function generateStrongPassword() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_+=?';
  var limit = Math.floor(256 / alphabet.length) * alphabet.length;
  var chars = [];
  while (chars.length < 24) {
    var bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    for (var i = 0; i < bytes.length && chars.length < 24; i++) {
      if (bytes[i] < limit) chars.push(alphabet[bytes[i] % alphabet.length]);
    }
  }
  return chars.join('');
}
