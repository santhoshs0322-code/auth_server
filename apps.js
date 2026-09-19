// This allowlist is the only place where an app may select a redirect scheme
// or MongoDB collection. Never accept collection names directly from requests.
module.exports = Object.freeze({
  balloonpop: Object.freeze({
    displayName: "Balloon Pop",
    redirectScheme: "balloonpop",
    userCollection: "balloonpop_users"
  }),
  candycraze: Object.freeze({
    displayName: "Candy Craze",
    redirectScheme: "candycraze",
    userCollection: "candycraze_users"
  })
});
