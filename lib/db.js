const { MongoClient } = require('mongodb');
const config = require('../config');

let client, collection;

async function connectDB() {
  if (!config.mongoUri) throw new Error('MONGODB_URI env variable set karala na!');
  client = new MongoClient(config.mongoUri);
  await client.connect();
  collection = client.db(config.dbName).collection('sessions');
  await collection.createIndex({ sessionId: 1 });
  console.log('✅ MongoDB connected');
  return collection;
}

const getCollection = () => {
  if (!collection) throw new Error('DB not connected yet');
  return collection;
};

module.exports = { connectDB, getCollection };
