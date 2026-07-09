function parseInfo(input) {
  const lines = input.split("\n").map(line => line.trim()).filter(Boolean);

  const result = {
    names: [],
    SSN: null,
    DOB: null,
    DL: null,
    addresses: [],
    phoneNumbers: []
  };

  let section = "names"; // default section before reaching addresses/phones

  for (const line of lines) {
    if (line.startsWith("SSN:")) {
      result.SSN = line.replace("SSN:", "").trim();
      section = null;
    } else if (line.startsWith("DOB:")) {
      result.DOB = line.replace("DOB:", "").trim();
      section = null;
    } else if (line.startsWith("DL:")) {
      result.DL = line.replace("DL:", "").trim();
      section = null;
    } else if (line.startsWith("Addresses:")) {
      section = "addresses";
    } else if (line.startsWith("Phone Numbers:")) {
      section = "phoneNumbers";
    } else {
      // Depending on which section we are in, push data
      if (section === "names") {
        result.names.push(line);
      } else if (section === "addresses") {
        result.addresses.push(line);
      } else if (section === "phoneNumbers") {
        result.phoneNumbers.push(line);
      }
    }
  }

  return result;
}


function stringifyInfo(obj) {
  let output = "";

  // Models (each in a new line)
  if (obj.names?.length) {
    output += obj.names.join("\n") + "\n";
  }

  // SSN, DOB, DL
  if (obj.SSN) output += `SSN: ${obj.SSN}\n`;
  if (obj.DOB) output += `DOB: ${obj.DOB}\n`;
  if (obj.DL) output += `DL: ${obj.DL}\n`;

  // Addresses
  if (obj.addresses?.length) {
    output += "Addresses:\n";
    output += obj.addresses.join("\n") + "\n";
  }

  // Phone Numbers
  if (obj.phoneNumbers?.length) {
    output += "Phone Numbers:\n";
    output += obj.phoneNumbers.join("\n") + "\n";
  }

  // Remove any trailing newline
  return output.trim();
}



