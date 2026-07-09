// scripts/initDatabase.js
const mongoose = require('mongoose');
const { seedTasks } = require('../seeders/taskSeeder');
const { seedConfigurations } = require('../seeders/configSeeder');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');

// Set mongoose options
mongoose.set('strictQuery', false); // Fix deprecation warning

// Database initialization function
const initializeDatabase = async () => {
  try {
    console.log('🚀 Starting database initialization...\n');
    
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');
    
    // Create necessary directories
    // await createDirectories();
    
    // Seed configurations
    // console.log('📝 Seeding configurations...');
    // await seedConfigurations();
    // console.log('✅ Configurations seeded successfully\n');
    
    // Seed tasks
    console.log('📋 Seeding tasks...');
    await seedTasks();
    console.log('✅ Tasks seeded successfully\n');
    
    // Create default admin user if it doesn't exist
    // console.log('👤 Creating default admin user...');
    // await createDefaultAdmin();
    // console.log('✅ Default admin user setup completed\n');
    
    // Create sample client user if it doesn't exist
    // console.log('👥 Creating sample client user...');
    // await createSampleClient();
    // console.log('✅ Sample client user setup completed\n');
    
    console.log('🎉 Database initialization completed successfully!');
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  }
};

// Create necessary directories
const createDirectories = async () => {
  const directories = [
    'uploads/temp',
    'uploads/csv-documents', // For permanent CSV storage
    'storage/results',
    'storage/logs'
  ];
  
  for (const dir of directories) {
    const fullPath = path.join(process.cwd(), dir);
    try {
      await fs.access(fullPath);
      console.log(`✓ Directory ${dir} already exists`);
    } catch {
      await fs.mkdir(fullPath, { recursive: true });
      console.log(`✓ Created directory ${dir}`);
    }
  }
  console.log();
};

// Create default admin user
const createDefaultAdmin = async () => {
  const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@forestlookup.com';
  const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123!';
  
  const existingAdmin = await User.findOne({ email: adminEmail });
  
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash(adminPassword, 12);
    
    const admin = new User({
      email: adminEmail,
      password: hashedPassword,
      role: 'admin',
      isActive: true,
      profile: {
        firstName: 'System',
        lastName: 'Administrator'
      }
    });
    
    await admin.save();
    console.log(`✓ Admin user created with email: ${adminEmail}`);
    console.log(`✓ Default password: ${adminPassword}`);
    console.log('⚠️  Please change the default password after first login!');
  } else {
    console.log(`- Admin user already exists: ${adminEmail}`);
  }
};

// Create sample client user
const createSampleClient = async () => {
  const clientEmail = process.env.DEFAULT_CLIENT_EMAIL || 'client@example.com';
  const clientPassword = process.env.DEFAULT_CLIENT_PASSWORD || 'client123!';
  const defaultBalance = process.env.DEFAULT_CLIENT_BALANCE || 5;
  
  const existingClient = await User.findOne({ email: clientEmail });
  
  if (!existingClient) {
    const hashedPassword = await bcrypt.hash(clientPassword, 12);
    
    const client = new User({
      email: clientEmail,
      password: hashedPassword,
      role: 'client',
      balance: parseFloat(defaultBalance),
      isActive: true,
      profile: {
        firstName: 'Sample',
        lastName: 'Client',
        company: 'Test Company'
      }
    });
    
    await client.save();
    console.log(`✓ Sample client created with email: ${clientEmail}`);
    console.log(`✓ Default password: ${clientPassword}`);
    console.log(`✓ Initial balance: ${defaultBalance}`);
  } else {
    console.log(`- Sample client already exists: ${clientEmail}`);
  }
};

// Cleanup function for development
const cleanupDatabase = async () => {
  try {
    console.log('🧹 Starting database cleanup...\n');
    
    // Connect to MongoDB
    const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/forest_lookup_db';
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB\n');
    
    // Drop all collections
    const collections = await mongoose.connection.db.collections();
    
    for (const collection of collections) {
      await collection.drop();
      console.log(`✓ Dropped collection: ${collection.collectionName}`);
    }
    
    console.log('\n🎉 Database cleanup completed!');
    
  } catch (error) {
    console.error('❌ Database cleanup failed:', error);
  }
};

// Environment validation
const validateEnvironment = () => {
  const requiredEnvVars = [
    'FOREST_API_BASE_URL',
    'FOREST_API_KEY',
    'JWT_SECRET'
  ];
  
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:');
    missingVars.forEach(varName => {
      console.error(`   - ${varName}`);
    });
    console.error('\nPlease set these variables in your .env file');
    process.exit(1);
  }
  
  console.log('✅ Environment variables validated\n');
};

// Main execution
const main = async () => {
  try {
    // Load environment variables
    require('dotenv').config();
    
    // Validate environment
    validateEnvironment();
    
    // Check command line arguments
    const command = process.argv[2];
    
    if (command === 'cleanup') {
      await cleanupDatabase();
    } else if (command === 'init' || !command) {
      await initializeDatabase();
    } else {
      console.log('Usage:');
      console.log('  node scripts/initDatabase.js init     - Initialize database with default data');
      console.log('  node scripts/initDatabase.js cleanup  - Clean up database (development only)');
    }
    
  } catch (error) {
    console.error('❌ Script execution failed:', error);
    process.exit(1);
  } finally {
    // Close database connection
    await mongoose.connection.close();
    console.log('\n🔐 Database connection closed');
    process.exit(0);
  }
};

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = {
  initializeDatabase,
  cleanupDatabase,
  createDefaultAdmin,
  createSampleClient
};