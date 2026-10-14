const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

// Baileys auth state -> MongoDB (memory cache + ordered writes, signal keys corrupt wenne na)
async function useMongoAuthState(collection, sessionId) {
  const id = key => `${sessionId}:${key}`;
  const cache = new Map();
  const queue = new Map();

  // same key ekata writes order ekata run wenna
  const enqueue = (key, fn) => {
    const p = (queue.get(key) || Promise.resolve()).then(fn, fn);
    queue.set(key, p);
    p.catch(() => {}).finally(() => {
      if (queue.get(key) === p) queue.delete(key);
    });
    return p;
  };

  const write = (data, key) => {
    cache.set(key, data);
    const json = JSON.stringify(data, BufferJSON.replacer);
    return enqueue(key, () =>
      collection.replaceOne(
        { _id: id(key) },
        { _id: id(key), sessionId, key, data: json },
        { upsert: true }
      )
    );
  };

  const read = async key => {
    if (cache.has(key)) return cache.get(key);
    const doc = await collection.findOne({ _id: id(key) });
    const value = doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
    if (value) cache.set(key, value);
    return value;
  };

  const remove = key => {
    cache.delete(key);
    return enqueue(key, () => collection.deleteOne({ _id: id(key) }));
  };

  const creds = (await read('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async keyId => {
              let value = await read(`${type}-${keyId}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[keyId] = value;
            })
          );
          return data;
        },
        set: async data => {
          const tasks = [];
          for (const category in data) {
            for (const keyId in data[category]) {
              const value = data[category][keyId];
              const key = `${category}-${keyId}`;
              tasks.push(value ? write(value, key) : remove(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => write(creds, 'creds')
  };
}

module.exports = { useMongoAuthState };
