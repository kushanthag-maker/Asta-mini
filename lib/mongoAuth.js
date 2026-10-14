const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

// Baileys auth state -> MongoDB (heroku restart unath session yanne na)
async function useMongoAuthState(collection, sessionId) {
  const id = key => `${sessionId}:${key}`;

  const write = (data, key) =>
    collection.replaceOne(
      { _id: id(key) },
      { _id: id(key), sessionId, key, data: JSON.stringify(data, BufferJSON.replacer) },
      { upsert: true }
    );

  const read = async key => {
    const doc = await collection.findOne({ _id: id(key) });
    return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
  };

  const remove = key => collection.deleteOne({ _id: id(key) });

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
