const defaultTasks = [
  {
    name: 'SSN-DOB-1',
    endpoint: '/createTask1',
    pricePerRequest: 1.0,
    description: 'SSN-DOB lookup type 1',
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
  {
    name: 'DL-Lookup',
    endpoint: '/createTaskDL',
    pricePerRequest: 1.5,
    description: 'Driver License lookup',
    fields: [
      { name: 'firstname', type: 'string', required: true, description: 'First name' },
      { name: 'lastname', type: 'string', required: true, description: 'Last name' },
      { name: 'address', type: 'string', required: true, description: 'Address' },
      { name: 'city', type: 'string', required: true, description: 'City' },
      { name: 'state', type: 'string', required: true, description: 'State' },
      { name: 'zip', type: 'string', required: true, description: 'ZIP code' },
      { name: 'dob', type: 'string', required: true, description: 'Date of birth (MM/DD/YYYY)' }
    ],
    csvTemplate: {
      headers: ['firstname', 'lastname', 'address', 'city', 'state', 'zip', 'dob'],
      exampleData: 'John,Doe,123 Main St,Anytown,CA,12345,01/15/1990'
    }
  },
  {
    name: 'SSN-DOB-DL',
    endpoint: '/createTask_SSN_DL',
    pricePerRequest: 2.0,
    description: 'Combined SSN-DOB and DL lookup (special pricing if DL not found)',
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
  {
    name: 'NAME-DOB',
    endpoint: '/createTask_NAME_DOB',
    pricePerRequest: 0.8,
    description: 'Name and DOB lookup',
    fields: [
      { name: 'name', type: 'string', required: true, description: 'First name' },
      { name: 'lastname', type: 'string', required: true, description: 'Last name' },
      { name: 'state', type: 'string', required: true, description: 'State' },
      { name: 'dob', type: 'string', required: true, description: 'Date of birth' }
    ],
    csvTemplate: {
      headers: ['name', 'lastname', 'state', 'dob'],
      exampleData: 'John,Doe,CA,01/15/1990'
    }
  },
  {
    name: 'NAME-ZIP',
    endpoint: '/createTask_SSN_ZIP',
    pricePerRequest: 5,
    description: 'Name Zip Lookup',
    fields: [
      { name: 'name', type: 'string', required: true, description: 'name' },
      { name: 'lastname', type: 'string', required: true, description: 'Last name' },
      { name: 'zip', type: 'string', required: true, description: 'ZIP code' },
    ],
    csvTemplate: {
      headers: ['name', 'lastname',  'zip', ],
      exampleData: 'John,Doe,12345'
    }
  },
  {
    name: 'REV-PHONE',
    endpoint: '/createTask_REV_PHONE',
    pricePerRequest: 5,
    description: 'Reverse Phone lookup',
    fields: [
      { name: 'phone', type: 'string', required: true, description: 'Phone number (10 digits)' },
    ],
    csvTemplate: {
      headers: ['phone'],
      exampleData: '2221234567'
    }
  },
   {
    name: 'REV-ADDRESS',
    endpoint: '/createTask_REV_ADDRESS',
    pricePerRequest: 5,
    description: 'Reverse Address lookup',
    fields: [
      { name: 'address_line', type: 'string', required: true, description: 'Address Line' },
      { name: 'city', type: 'string', required: true, description: 'City' },
      { name: 'state_code', type: 'string', required: true, description: 'State Code' },
      { name: 'zip_code', type: 'string', required: true, description: 'Zip Code' }
    ],
    csvTemplate: {
      headers: ['address_line', 'city', 'state_code', 'zip_code'],
      exampleData: 'addres-line,city,00,555'
    }
  },
];