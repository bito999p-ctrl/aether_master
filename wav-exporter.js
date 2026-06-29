/**
 * AudioBufferを16-bit PCMのWAVフォーマットに変換するユーティリティ
 * @param {AudioBuffer} audioBuffer - レンダリングされたAudioBuffer
 * @returns {Blob} - WAVファイルのBlobオブジェクト
 */
export function bufferToWav(audioBuffer) {
  const numOfChan = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // 1 = Raw PCM (integer), 3 = IEEE Float
  const bitDepth = 16;
  
  const resultLength = audioBuffer.length * numOfChan * (bitDepth / 8);
  const buffer = new ArrayBuffer(44 + resultLength);
  const view = new DataView(buffer);
  
  let pos = 0;

  // 補助関数: 文字列を書き込む
  function writeString(str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(pos + i, str.charCodeAt(i));
    }
    pos += str.length;
  }

  // 補助関数: 16ビット符号なし整数を書き込む
  function writeUint16(val) {
    view.setUint16(pos, val, true); // リトルエンディアン
    pos += 2;
  }

  // 補助関数: 32ビット符号なし整数を書き込む
  function writeUint32(val) {
    view.setUint32(pos, val, true);
    pos += 4;
  }

  // 1. RIFFヘッダ
  writeString('RIFF');                         // Chunk ID
  writeUint32(36 + resultLength);              // Chunk Size
  writeString('WAVE');                         // Format

  // 2. fmt サブチャンク
  writeString('fmt ');                         // Subchunk1 ID
  writeUint32(16);                             // Subchunk1 Size (16 for PCM)
  writeUint16(format);                         // Audio Format (1 = PCM)
  writeUint16(numOfChan);                      // Num Channels
  writeUint32(sampleRate);                     // Sample Rate
  writeUint32(sampleRate * numOfChan * (bitDepth / 8)); // Byte Rate
  writeUint16(numOfChan * (bitDepth / 8));     // Block Align
  writeUint16(bitDepth);                       // Bits Per Sample

  // 3. data サブチャンク
  writeString('data');                         // Subchunk2 ID
  writeUint32(resultLength);                   // Subchunk2 Size

  // 4. オーディオデータの書き込み（インプレース・インターリーブ）
  const channels = [];
  for (let i = 0; i < numOfChan; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  const length = audioBuffer.length;
  for (let offset = 0; offset < length; offset++) {
    for (let i = 0; i < numOfChan; i++) {
      let sample = channels[i][offset];
      
      // クリッピング防止のクリップ処理
      if (sample > 1.0) sample = 1.0;
      else if (sample < -1.0) sample = -1.0;
      
      // 16-bit PCM (-32768 〜 32767) へ変換
      const s = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(pos, s, true);
      pos += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
