const { ethers } = require("ethers");
const axios = require("axios");
require("dotenv").config();

const { v4: uuidv4 } = require("uuid");

const { callOpenAI } = require("./ai");
const { fetchFIDs, fetchMemoraNFTData, triggerNFT, fetchMemoraBTCData, triggerMemoraBTC } = require("./chain");
const { upsertUser, getUserById, upsertTrigger, flagInvalidUser, storeUserMessages } = require("./db");
const { fetchNFTPrompt, fetchMemoraBTCPrompt } = require("./chain");

const warpcast_url = "https://api.warpcast.com/v2/ext-send-direct-cast";

const updatePosts = async (handle) => {
  try {
    // Fetch all NFT minters
    // allMinters = await fetchMemoraNFTData();
    allMinters = await fetchMemoraBTCData();

    //   dumb: allMinters = [[0, "0xad1aa5d1eea542277cfb451a94843c41d2c25ed8"]];

    // Get the FID from the farcaster registry
    //   allFIDs = await fetchFIDs(allMinters); (no longer needed, we store it)

    // Call Farcaster's public hubble to get user's posts
    allPosts = [];
    updatedUsers = {};
    for (i in allMinters) {
      fid = allMinters[i][2];
      let storedUser = null;
      try {
        storedUser = await getUserById(fid);        
      } catch (error) {
        console.error(`Error fetching or creating user with ID ${fid}:`, error);
        continue; // Skip this user and move to the next one
      }

      if (storedUser != null && storedUser.invalidUser === true) continue;
      let check = await checkFIDExists(fid);
      console.log("checking user exists : ",check);
      if (storedUser == null && !check) {     
        console.log("user doesn't exist, moving on....."); 
        continue;
      }
      if (storedUser == null) {
        // If user doesn't exist, create a new user
        storedUser = await upsertUser(fid, new Date(), JSON.stringify([]));
        console.log(`Created new user with ID: ${fid}`);
      }
      let fidData =
        fid != 0 ? await fetchCastsByFid(fid) : { posts: [""], timestamp: 0 };
      if (fidData.posts.length == 1 && fidData.posts[0] == "") {
        continue;
      }
      console.log("fidData, ", fidData);
      if (storedUser != null) {
        if (storedUser.messages == null) {
          storeUserMessages(fid, JSON.stringify(fidData.posts));
        }
      }
      // let newConvertedTime = Math.floor(new Date(storedUser.latestPost).getTime() / 1000);

      // Only call the AI if there are new posts
      // if (JSON.parse(storedUser.messages).length == 0 || new Date(storedUser.latestPost).getTime() / 1000 < fidData.timestamp) {
      if (true) {

        console.log("new posts for user ", fid);
        // Add new message storing logic in this function as in to add the new messages to the db too  
        // also as an edge case suppose the user posts more than 1 page of messages then the pages have to be combined and then stored
        let parsedMessage = []
        if(storedUser!= null) {
        parsedMessage = storedUser.messages === null ? [] : JSON.parse(storedUser.messages);
        }
        const combinedArray = Array.from(new Set([...parsedMessage, ...fidData["posts"]]));
        console.log({combinedArray});        
        posts = JSON.stringify(combinedArray);

        nftId = Number(allMinters[i][0]);

        // nftInfo = await fetchNFTPrompt(nftId);
        nftInfo = await fetchMemoraBTCPrompt(nftId);
        prompt = nftInfo.prompt;

        res = await callOpenAI(prompt, posts);

        console.log("decision: ", res);
        if (res == "yes") {
          try {
            triggerId = Number(await upsertTrigger(nftId, fid));
            // triggerNFT(nftId);
            triggerMemoraBTC(nftId);
            sendDM(fid, triggerId, "minter");
            heirFid = Number(await fetchFIDs([[0, nftInfo.heir]]));
            console.log("heir", heirFid);
            if (heirFid != 0) {
              sendDM(heirFid, triggerId, "heir");
            }
          } catch (error) {
            console.error(`Error creating trigger for user ${fid}:`, error);
          }
        }
        let timestamp = fidData.timestamp;
        // updatedUsers[fid] = {timestamp,posts};
        upsertUser(fid,timestamp,posts);

      }
    }
 
  } catch (err) {
    console.error("Error in updatePosts:", err);
  }
};

async function fetchCastsByFid(fid) {
  try {
    let allMessages = [];
    let nextPageToken = "";
    let timestamp = 0;
    do {
      // Fetch the casts, passing the nextPageToken if available
      const response = await axios.get(
        `https://hoyt.farcaster.xyz:2281/v1/castsByFid?fid=${fid}${nextPageToken ? `&nextPageToken=${nextPageToken}` : ""}`
      );

      const { messages, nextPageToken : newPageToken} = response.data;

      if (messages.length === 0 && !nextPageToken) {
        return { posts: [""], timestamp: 0 };
      }

      // Append the fetched messages to the allMessages array
      allMessages = allMessages.concat(messages);
      nextPageToken = newPageToken;

    } while (nextPageToken); // Continue fetching until no nextPageToken

    // Ensure messages are sorted by timestamp
    const isSorted = allMessages.every(
      (message, index, array) =>
        index === 0 ||
        message.data.timestamp >= array[index - 1].data.timestamp
    );
    if (!isSorted) {
      console.log("Messages were not sorted. Sorting now...");
      allMessages = allMessages.sort(
        (a, b) => a.data.timestamp - b.data.timestamp
      );
    }

    // Extract the timestamp of the last message
    timestamp = allMessages.slice(-1)[0].data.timestamp;

    return {
      posts: allMessages.map((message) =>
        message.data.castAddBody ? message.data.castAddBody.text : ""
      ),
      timestamp: timestamp,
    };
  } catch (error) {
    throw error;
  }
}


async function sendDM(fid, triggerId, role) {
  fid = Number(fid);
  uid = uuidv4();
  if (role == "minter") {
    message =
      "Looks like one of your memora was triggered! Check it out here: https://memora.today/dashboard/";
    triggerId = triggerId + "m" + uid;
  } else {
    message =
      "You have inherited a memora! Check it out here: https://memora.today/dashboard/";
    triggerId = triggerId + "h" + uid;
  }
  const data = {
    recipientFid: fid,
    message: message,
    idempotencyKey: triggerId,
  };

  let config = {
    method: "put",
    maxBodyLength: Infinity,
    url: "https://api.warpcast.com/v2/ext-send-direct-cast",
    headers: {
      "User-Agent": "-u",
      Authorization: `Bearer ${process.env.WARPCAST_API_KEY}`,
    },
    data: data,
  };
  axios
    .request(config)
    .then((response) => {
      console.log(JSON.stringify(response.data));
    })
    .catch((error) => {
      console.log(error);
    });
}


async function checkFIDExists(fid) {
try{  fid = ethers.toBeHex(fid);
  fid = fid.toString();
  let config = {
    method: 'get',
    maxBodyLength: Infinity,
    url: `https://hoyt.farcaster.xyz:2281/v1/userDataByFid?fid=${fid}&user_data_type=1`,
    headers: {}
  };

 let response = await axios.request(config);
 if(response.data.data.fid){
  return true;
 }
 else{
  return false;
 }   }
 catch(error){
   return false;
 }
}


// TODO with DB:
// store users: FID, Latest post date, Latest AI decision

// fetchCastsByFid(3)
//   .then((result) => {
//     console.log(result.slice(-100)); // Output: Data fetched successfully
//   })
//   .catch((err) => {
//     console.error(err); // Handle any errors
//   });

// listenToPosts()
//   .then((result) => {
//     console.log(result); // Output: Data fetched successfully
//   })
//   .catch((err) => {
//     console.error(err); // Handle any errors
//   });

// sendDM(855266);

// fetchCastsByFid(855266).then((result) => {
//   console.log(result); // Output: Data fetched successfully
// });

// let fidData = (fid != 0 ? fetchCastsByFid(855266) : [""], 0);
// fetchCastsByFid(855266).then((result) => {
//   //   allPosts[i] = result.posts.join(";");
//   console.log(result.timestamp);
//   upsertUser(855266, result.timestamp);
// });

// timestamp =
// listenToPosts({});

module.exports = updatePosts;
