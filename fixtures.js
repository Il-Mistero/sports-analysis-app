// api/fixtures.js
const API_KEY = '853d7affb6ef483d9fa2058994f9f4ae';
const BASE_URL = 'https://api.football-data.org/v4';

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { league = 'PL' } = req.query;

        // Get current date range for this week
        const today = new Date();
        const startDate = new Date(today);
        startDate.setDate(today.getDate() - today.getDay()); // Start of week
        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 7); // End of week

        const dateFrom = startDate.toISOString().split('T')[0];
        const dateTo = endDate.toISOString().split('T')[0];

        // Fetch fixtures
        const fixturesResponse = await fetch(
            `${BASE_URL}/competitions/${league}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
            {
                headers: {
                    'X-Auth-Token': API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!fixturesResponse.ok) {
            throw new Error(`Football API error: ${fixturesResponse.status} ${fixturesResponse.statusText}`);
        }

        const fixturesData = await fixturesResponse.json();

        // Fetch team standings for better probability calculations
        let standings = {};
        try {
            const standingsResponse = await fetch(
                `${BASE_URL}/competitions/${league}/standings`,
                {
                    headers: {
                        'X-Auth-Token': API_KEY,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (standingsResponse.ok) {
                const standingsData = await standingsResponse.json();
                if (standingsData.standings && standingsData.standings[0] && standingsData.standings[0].table) {
                    standingsData.standings[0].table.forEach(team => {
                        standings[team.team.id] = {
                            position: team.position,
                            points: team.points,
                            goalsFor: team.goalsFor,
                            goalsAgainst: team.goalsAgainst,
                            goalDifference: team.goalDifference,
                            won: team.won,
                            draw: team.draw,
                            lost: team.lost,
                            played: team.playedGames
                        };
                    });
                }
            }
        } catch (standingsError) {
            console.warn('Could not fetch standings:', standingsError);
        }

        // Calculate probabilities for each match
        const matchesWithProbabilities = fixturesData.matches.map(match => {
            if (match.status === 'SCHEDULED' || match.status === 'TIMED') {
                const probabilities = calculateProbabilities(
                    match.homeTeam,
                    match.awayTeam,
                    standings[match.homeTeam.id],
                    standings[match.awayTeam.id]
                );

                return {
                    ...match,
                    probabilities
                };
            }
            return match;
        });

        // Set cache headers
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
        
        res.status(200).json({
            ...fixturesData,
            matches: matchesWithProbabilities,
            standings,
            lastUpdated: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error fetching fixtures:', error);
        res.status(500).json({ 
            error: 'Failed to fetch fixtures',
            message: error.message 
        });
    }
}

function calculateProbabilities(homeTeam, awayTeam, homeStats = {}, awayStats = {}) {
    // Calculate team strength based on available data
    const homeStrength = calculateTeamStrength(homeStats);
    const awayStrength = calculateTeamStrength(awayStats);
    
    // Home advantage factor
    const homeAdvantage = 0.1;
    const adjustedHomeStrength = homeStrength + homeAdvantage;
    
    // Win probabilities
    const totalStrength = adjustedHomeStrength + awayStrength + 0.3; // 0.3 for draw possibility
    let team1Win = adjustedHomeStrength / totalStrength;
    let team2Win = awayStrength / totalStrength;
    
    // Ensure probabilities are reasonable
    team1Win = Math.max(0.15, Math.min(0.75, team1Win));
    team2Win = Math.max(0.15, Math.min(0.75, team2Win));
    
    // Goal-based probabilities
    const homeGoalsPerGame = homeStats.goalsFor ? homeStats.goalsFor / homeStats.played : 1.5;
    const awayGoalsPerGame = awayStats.goalsFor ? awayStats.goalsFor / awayStats.played : 1.5;
    const expectedGoals = homeGoalsPerGame + awayGoalsPerGame;
    
    // Calculate goal probabilities using Poisson distribution approximation
    const over1_5 = expectedGoals > 1.5 ? Math.min(0.95, 0.6 + (expectedGoals - 1.5) * 0.15) : 0.4 + expectedGoals * 0.13;
    const under1_5 = 1 - over1_5;
    const over2_5 = expectedGoals > 2.5 ? Math.min(0.85, 0.4 + (expectedGoals - 2.5) * 0.12) : 0.25 + expectedGoals * 0.1;
    
    // First half probabilities (typically 60% of full game)
    const firstHalfExpected = expectedGoals * 0.6;
    const firstHalfOver0_5 = Math.min(0.9, 0.5 + firstHalfExpected * 0.2);
    const firstHalfUnder1_5 = Math.min(0.9, 0.7 - firstHalfExpected * 0.1);
    
    return {
        team1Win: parseFloat(team1Win.toFixed(2)),
        team2Win: parseFloat(team2Win.toFixed(2)),
        over1_5: parseFloat(over1_5.toFixed(2)),
        under1_5: parseFloat(under1_5.toFixed(2)),
        over2_5: parseFloat(over2_5.toFixed(2)),
        firstHalfOver0_5: parseFloat(firstHalfOver0_5.toFixed(2)),
        firstHalfUnder1_5: parseFloat(firstHalfUnder1_5.toFixed(2))
    };
}

function calculateTeamStrength(stats) {
    if (!stats || !stats.played || stats.played === 0) {
        return 0.5; // Default strength for teams without stats
    }
    
    // Points per game (max 3)
    const ppg = stats.points / stats.played / 3;
    
    // Goal difference per game
    const gdpg = stats.goalDifference / stats.played;
    const normalizedGD = Math.max(-1, Math.min(1, gdpg / 3)); // Normalize between -1 and 1
    
    // Win ratio
    const winRatio = stats.won / stats.played;
    
    // Combine factors
    const strength = (ppg * 0.4) + ((normalizedGD + 1) / 2 * 0.3) + (winRatio * 0.3);
    
    return Math.max(0.1, Math.min(0.9, strength));
}