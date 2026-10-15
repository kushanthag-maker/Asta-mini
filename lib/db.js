const { MongoClient } = require('mongodb');
const config = require('../config');

let client;
let collection;

async function connectDB() {
  if (collection) return collection;
  if (!config.mongoUri) throw new Error('MONGODB_URI environment variable is missing');

  client = new MongoClient(config.mongoUri, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    maxPoolSize: 10
  });

  try {
    await client.connect();
    collection = client.db(config.dbName).collection('sessions');
    await collection.createIndex({ sessionId: 1, key: 1 });
    console.log('✅ MongoDB connected');
    return collection;
  } catch (error) {
    collection = undefined;
    await client.close().catch(() => {});
    client = undefined;
    throw error;
  }
}

function getCollection() {
  if (!collection) throw new Error('MongoDB is not connected');
  return collection;
}

async function closeDB() {
  const current = client;
  client = undefined;
  collection = undefined;
  if (current) await current.close();
}

module.exports = { connectDB, getCollection, closeDB };
