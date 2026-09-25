// Data processing utilities

// BUG 1: Off-by-one error — loop goes one past the array end
function sumArray(arr) {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i]; // arr[arr.length] is undefined → NaN
  }
  return total;
}

// BUG 2: Mutating the input array instead of a copy — unexpected side effects
function removeDuplicates(items) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i] === items[j]) {
        items.splice(j, 1); // mutates caller's array
        j--;
      }
    }
  }
  return items;
}

// BUG 3: Integer division discards remainder — silent precision loss
function average(nums) {
  return (nums.reduce((a, b) => a + b, 0) / nums.length) | 0; // bitwise OR truncates
}

// BUG 4: Swallowed error — exception silently returns null, hiding failures
async function fetchData(url) {
  try {
    const res = await fetch(url);
    return await res.json();
  } catch (e) {
    return null; // caller never knows the request failed
  }
}

// BUG 5: SQL injection via string concatenation — should use parameterised queries
function buildQuery(tableName, userId) {
  return `SELECT * FROM ${tableName} WHERE id = ` + userId;
}

module.exports = { sumArray, removeDuplicates, average, fetchData, buildQuery };
