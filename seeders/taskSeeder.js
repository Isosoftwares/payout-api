// seeders/taskSeeder.js
const Task = require('../models/Task');

const defaultTasks = [
   {
    name: 'SSN-DOB-2',
    endpoint: '/createTask2',
    pricePerRequest: 1.0,
    description: 'SSN-DOB lookup type 2',
    fields: [
      { name: 'firstname', type: 'string', required: true, description: 'First name' },
      { name: 'lastname', type: 'string', required: true, description: 'Last name' },
      { name: 'address', type: 'string', required: true, description: 'Address' },
      { name: 'city', type: 'string', required: true, description: 'City' },
      { name: 'state', type: 'string', required: true, description: 'State' },
      { name: 'zip', type: 'string', required: true, description: 'ZIP code' }
    ],
    csvTemplate: {
      headers: ['firstname', 'lastname', 'address', 'city', 'state', 'zip'],
      exampleData: 'John,Doe,123 Main St,Anytown,CA,12345'
    }
  },
];

const seedTasks = async () => {
  try {
    console.log('Seeding tasks...');
    
    // First, let's clean up any malformed task data
    try {
      // await Task.deleteMany({});
      // console.log('✓ Cleaned up existing task data');
    } catch (cleanupError) {
      console.log('- No existing tasks to clean up');
    }
    
    // Now insert fresh data
    for (const taskData of defaultTasks) {
      try {
        const task = new Task(taskData);
        await task.save();
        console.log(`✓ Task ${taskData.name} seeded successfully`);
      } catch (error) {
        console.error(`✗ Error seeding task ${taskData.name}:`, error.message);
        // Continue with other tasks even if one fails
      }
    }
    
    console.log('All tasks seeded successfully!');
  } catch (error) {
    console.error('Error seeding tasks:', error);
    throw error;
  }
};

module.exports = { seedTasks, defaultTasks };