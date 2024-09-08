import Axios from "axios";
class ApiService {
    private userDetailMap = new Map<string, string>();
    private axios;

    constructor() {
        this.axios = Axios.create();
    }

    async userDescription(accessToken: string, userId: string): Promise<string | null> {
        if (this.userDetailMap.has(userId)) {
            const response = this.userDetailMap.get(userId);
            if (response) {
                return response;
            } else {
                return null;
            }
        } else {
            try {
                const response = await this.axios.post(
                    "https://api.jaewon.co.kr/_matrix-internal/users/v1/description",
                    JSON.stringify({
                        userId,
                        accessToken,
                    }),
                    {
                        headers: {
                            "Content-Type": "application/json",
                        },
                        params: {
                            t: Date.now(),
                        },
                    },
                );

                const description = response.data?.description ?? "No description";

                if (description !== "No description") {
                    this.userDetailMap.set(userId, description);
                }
                return description;
            } catch (e) {
                return null;
            }
        }
    }
}

export default new ApiService();
